// sokuji-audio-host — per-application audio capture for Windows.
//
//   sokuji-audio-host.exe --list
//       Writes one JSON array to stdout and exits 0.
//       [{"id":"pid:1234","label":"Zoom Meetings","exe":"Zoom.exe","active":true,
//         "windows":["Zoom Meeting","Chat"]}]
//       `id` names the application's root process, which outlives the child
//       that happens to hold the audio session. `label` is the application
//       name; `windows` are its window titles, which the UI shows on hover
//       because one process can own several windows and Windows cannot capture
//       them separately.
//
//   sokuji-audio-host.exe --devices
//       Writes one JSON array to stdout and exits 0 (1 if the device
//       enumerator cannot be created, with nothing on stdout). One row per
//       active render endpoint:
//         [{"id":"{0.0.0.00000000}.{...}","label":"Speakers (Realtek(R) Audio)",
//           "browserLabel":"Speakers (Realtek(R) Audio)",
//           "isDefault":true,"formFactor":1,"enumerator":"HDAUDIO"}]
//       `label` is PKEY_Device_FriendlyName. `browserLabel` is the text
//       Chromium shows for the output: that name plus the suffix Chromium
//       appends, " (0951:16a4)" for USB and " (Bluetooth)" for Bluetooth.
//       `formFactor` is PKEY_AudioEndpoint_FormFactor (EndpointFormFactor) and
//       `enumerator` is PKEY_Device_EnumeratorName; each is null when the
//       endpoint does not state it.
//
//   sokuji-audio-host.exe --target pid:1234
//       Writes raw PCM to stdout until killed. Format is fixed at
//       24000 Hz, 1 channel, signed 16-bit little-endian.
//
//   sokuji-audio-host.exe --target system
//       Captures the global mix on the current default multimedia render
//       endpoint using shared-mode WASAPI loopback, with the same PCM protocol.
//       Writes one JSON object per line to stderr:
//         {"event":"format","sampleRate":24000,"channels":1,"encoding":"s16le"}
//         {"event":"error","code":"..."}
//
//   sokuji-audio-host.exe --target endpoint:<IMMDevice id>
//       Captures only that active physical render endpoint. It never falls
//       back to the current default endpoint.
//
// Exit codes: 0 clean, 1 runtime failure, 2 bad usage.
//
// stdout carries ONLY PCM. Everything else goes to stderr, or the audio stream
// is corrupted. Built with plain MSVC — deliberately no WIL and no Media
// Foundation, unlike the Microsoft ApplicationLoopback sample this is based on.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
// initguid.h makes the property-key header below define its keys instead of
// declaring them, so nothing needs a .lib. Placed after mmdeviceapi.h so the
// interface ids that header declares stay as they were.
#include <initguid.h>
#include <functiondiscoverykeys_devpkey.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <devicetopology.h>
#include <tlhelp32.h>
#include <winver.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <cmath>
#include <cstdint>

// The pipeline consumes 24 kHz mono s16 and nothing else, so the format is not
// configurable. WASAPI converts from whatever the app renders via
// AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM.
static const DWORD kSampleRate = 24000;
static const WORD  kChannels   = 1;
static const WORD  kBits       = 16;

// ---------------------------------------------------------------- utilities

// Window titles and executable names are UTF-16 and routinely non-ASCII.
// Converting through the console code page (printf("%S")) mangles them.
static std::string Utf8(const wchar_t* w) {
    if (!w || !*w) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return std::string();
    std::string s(static_cast<size_t>(n - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
    return s;
}

static std::string JsonEscape(const std::string& in) {
    std::string o;
    o.reserve(in.size() + 8);
    for (unsigned char c : in) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
                else o += static_cast<char>(c);
        }
    }
    return o;
}

static void EmitEvent(const char* json) {
    fprintf(stderr, "%s\n", json);
    fflush(stderr);
}

static void EmitError(const char* code) {
    fprintf(stderr, "{\"event\":\"error\",\"code\":\"%s\"}\n", code);
    fflush(stderr);
}

static std::wstring ImagePathOf(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return std::wstring();
    wchar_t path[MAX_PATH] = {};
    DWORD n = MAX_PATH;
    std::wstring result;
    if (QueryFullProcessImageNameW(h, 0, path, &n)) result.assign(path, n);
    CloseHandle(h);
    return result;
}

static std::string ExeNameOf(DWORD pid) {
    const std::wstring path = ImagePathOf(pid);
    if (path.empty()) return std::string();
    const size_t slash = path.find_last_of(L'\\');
    return Utf8(slash == std::wstring::npos ? path.c_str() : path.c_str() + slash + 1);
}

/**
 * The executable's FileDescription resource - "Google Chrome" for chrome.exe.
 *
 * This is the name Task Manager shows, and the only application name Windows
 * offers for free; everything friendlier (AppUserModelID, package display name)
 * covers packaged apps only.
 */
static std::string FileDescription(const wchar_t* path) {
    DWORD ignored = 0;
    const DWORD size = GetFileVersionInfoSizeW(path, &ignored);
    if (size == 0) return std::string();
    std::vector<BYTE> buffer(size);
    if (!GetFileVersionInfoW(path, 0, size, buffer.data())) return std::string();

    struct LangCodePage { WORD language; WORD codePage; };
    LangCodePage* translations = nullptr;
    UINT bytes = 0;
    if (!VerQueryValueW(buffer.data(), L"\\VarFileInfo\\Translation",
                        reinterpret_cast<void**>(&translations), &bytes)
        || bytes < sizeof(LangCodePage)) {
        return std::string();
    }
    // The first translation is the binary's own language. Later ones are
    // localisations, which would name the app in a language nobody asked for.
    wchar_t key[64];
    swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription",
               translations[0].language, translations[0].codePage);
    wchar_t* value = nullptr;
    UINT length = 0;
    if (!VerQueryValueW(buffer.data(), key, reinterpret_cast<void**>(&value), &length)
        || length == 0) {
        return std::string();
    }
    return Utf8(value);
}

// ------------------------------------------------------------------- --list

struct TitleCollector {
    std::map<DWORD, std::vector<std::string>> byPid;
};

// Chromium and Electron render audio from a child process (the audio service),
// and that child owns no window, so nothing about the application can be read
// off the audio session's own pid. Walking up the parent chain reaches the
// process that does represent the app. Capped so a broken or cyclic chain
// cannot spin.
static const int kMaxParentHops = 6;

struct ProcessTable {
    std::map<DWORD, DWORD> parent;
    std::map<DWORD, std::string> image;
};

static ProcessTable BuildProcessTable() {
    ProcessTable table;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return table;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snap, &entry)) {
        do {
            table.parent[entry.th32ProcessID] = entry.th32ParentProcessID;
            // The snapshot's image name needs no handle, so it also covers
            // processes this helper may not open.
            table.image[entry.th32ProcessID] = Utf8(entry.szExeFile);
        } while (Process32NextW(snap, &entry));
    }
    CloseHandle(snap);
    return table;
}

static std::string ImageOf(DWORD pid, const ProcessTable& table) {
    auto it = table.image.find(pid);
    if (it != table.image.end() && !it->second.empty()) return it->second;
    return ExeNameOf(pid);
}

static bool SameImage(const std::string& a, const std::string& b) {
    return !a.empty() && !b.empty() && _stricmp(a.c_str(), b.c_str()) == 0;
}

/**
 * The process that represents the *application* holding this audio session.
 *
 * The session belongs to whichever process opened the render stream, and for a
 * multi-process app that is a short-lived child: Chrome plays through a
 * `--type=utility` audio service it tears down and replaces around playback.
 * Targeting that child produced a tap that died with it - the helper exited
 * `target_gone`, and Sokuji answers a dead helper by falling back to
 * whole-system capture while the picker still names the application, so the
 * user's whole desktop starts being translated with nothing on screen saying
 * so. Reporting the root instead gives a pid that lives as long as the app,
 * and PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE still reaches every
 * child it spawns - including the replacement audio service.
 *
 * The walk stops as soon as the parent runs a different executable, and that
 * bound is what makes it safe. Multi-process apps spawn their children from
 * their own image, whereas an unrelated parent - explorer.exe having launched a
 * window-less player - does not. Without the bound such an app's root would be
 * the desktop shell, and capturing that tree would capture nearly everything
 * the user has open: the exact leak this is meant to close.
 */
static DWORD AppRootPid(DWORD pid, const ProcessTable& table) {
    const std::string image = ImageOf(pid, table);
    if (image.empty()) return pid;
    DWORD root = pid;
    for (int hop = 0; hop < kMaxParentHops; hop++) {
        auto parent = table.parent.find(root);
        if (parent == table.parent.end()) break;
        const DWORD up = parent->second;
        // 0-4 are System/Idle; a self-referencing entry would loop forever.
        if (up <= 4 || up == root) break;
        if (!SameImage(ImageOf(up, table), image)) break;
        root = up;
    }

    // New Teams renders through a WebView2 audio service. Its session PID is
    // an msedgewebview2.exe child, while the process-loopback target needs the
    // Teams root so it survives WebView2 utility-process replacement. Only
    // promote WebView2 roots whose live parent chain reaches a known Teams
    // executable; never promote ordinary Edge/Chrome trees or arbitrary apps.
    if (SameImage(ImageOf(root, table), "msedgewebview2.exe")) {
        DWORD ancestor = root;
        for (int hop = 0; hop < kMaxParentHops; hop++) {
            auto parent = table.parent.find(ancestor);
            if (parent == table.parent.end()) break;
            const DWORD up = parent->second;
            if (up <= 4 || up == ancestor) break;
            const std::string parentImage = ImageOf(up, table);
            if (SameImage(parentImage, "ms-teams.exe")
                || SameImage(parentImage, "msteams.exe")
                || SameImage(parentImage, "teams.exe")) {
                return up;
            }
            ancestor = up;
        }
    }
    return root;
}

/**
 * What to call this application in the picker.
 *
 * Deliberately not a window title. A capturable source is a process tree, and
 * one tree routinely owns several windows - two Chrome windows are one process
 * and therefore one source, which Windows offers no way to split. Naming the
 * row after whichever window was enumerated first promised a granularity the OS
 * cannot deliver, and made two windows look like one arbitrary one. The window
 * titles still travel, in `windows`, for the UI to show on hover.
 */
static std::string FriendlyName(DWORD pid, const ProcessTable& table) {
    const std::wstring path = ImagePathOf(pid);
    if (!path.empty()) {
        const std::string described = FileDescription(path.c_str());
        if (!described.empty()) return described;
    }
    const std::string image = ImageOf(pid, table);
    if (!image.empty()) return image;
    char b[32];
    sprintf_s(b, "PID %lu", pid);
    return b;
}

static BOOL CALLBACK CollectTitle(HWND hwnd, LPARAM lp) {
    if (!IsWindowVisible(hwnd)) return TRUE;
    if (GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;  // tool/child window
    wchar_t title[256] = {};
    if (GetWindowTextW(hwnd, title, 255) == 0) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return TRUE;
    auto* c = reinterpret_cast<TitleCollector*>(lp);
    // Every window, not just the first: they are what the row's tooltip lists,
    // and dropping all but one is what made two Chrome windows indistinguishable.
    c->byPid[pid].push_back(Utf8(title));
    return TRUE;
}

struct Entry {
    DWORD pid;
    std::string exe;
    std::string label;
    bool active;
    std::vector<std::string> windows;
};

// Enumerate processes with sessions on any active render endpoint. Meeting
// apps can select a communications headset distinct from the default console
// endpoint; process-loopback capture is process-scoped, so the endpoint is
// needed only to discover session owners. Note this only sees the *current*
// Windows session, which is correct: Sokuji runs in the user's session.
static int ListSources() {
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&en))) {
        // No enumerator at all: emit an empty list so the picker degrades to
        // whole-system capture instead of showing an error.
        printf("[]");
        return 0;
    }

    IMMDeviceCollection* devices = nullptr;
    if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) {
        printf("[]");
        en->Release();
        return 0;
    }

    TitleCollector titles;
    EnumWindows(CollectTitle, reinterpret_cast<LPARAM>(&titles));
    const ProcessTable procs = BuildProcessTable();

    // A window belongs to the application, not to the process that happens to
    // own it, so fold every collected title onto its application root. One row
    // can then list every window the app has open.
    std::map<DWORD, std::vector<std::string>> windowsByRoot;
    for (const auto& owner : titles.byPid) {
        auto& into = windowsByRoot[AppRootPid(owner.first, procs)];
        for (const auto& title : owner.second) {
            if (std::find(into.begin(), into.end(), title) == into.end()) into.push_back(title);
        }
    }

    std::vector<Entry> entries;
    DWORD self = GetCurrentProcessId();
    UINT deviceCount = 0;
    devices->GetCount(&deviceCount);
    for (UINT d = 0; d < deviceCount; d++) {
        IMMDevice* dev = nullptr;
        if (FAILED(devices->Item(d, &dev))) continue;
        IAudioSessionManager2* mgr = nullptr;
        if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr))) {
            IAudioSessionEnumerator* sessions = nullptr;
            int count = 0;
            if (SUCCEEDED(mgr->GetSessionEnumerator(&sessions))) sessions->GetCount(&count);
            for (int i = 0; i < count; i++) {
                IAudioSessionControl* ctl = nullptr;
                if (FAILED(sessions->GetSession(i, &ctl))) continue;
                IAudioSessionControl2* ctl2 = nullptr;
                if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctl2))) {
                    DWORD pid = 0;
                    ctl2->GetProcessId(&pid);
                    // pid 0 is the system-wide session; capturing ourselves would loop.
                    if (pid != 0 && pid != self && ctl2->IsSystemSoundsSession() != S_OK) {
                        AudioSessionState st = AudioSessionStateInactive;
                        ctl->GetState(&st);
                        const DWORD root = AppRootPid(pid, procs);
                        Entry e{};
                        e.pid = root;
                        e.exe = ImageOf(root, procs);
                        e.active = (st == AudioSessionStateActive);
                        e.label = FriendlyName(root, procs);
                        auto windows = windowsByRoot.find(root);
                        if (windows != windowsByRoot.end()) e.windows = windows->second;
                        bool dup = false;
                        for (auto& x : entries) {
                            // Sessions on multiple endpoints still produce one row.
                            if (x.pid == root) { x.active = x.active || e.active; dup = true; break; }
                        }
                        if (!dup) entries.push_back(e);
                    }
                    ctl2->Release();
                }
                ctl->Release();
            }
            if (sessions) sessions->Release();
            mgr->Release();
        }
        dev->Release();
    }

    // Two instances of one application - a second Chrome profile, or Chrome
    // beside Chrome Beta - carry the same name here, and nothing in this list
    // tells them apart. Disambiguating them is the caller's job: it appends the
    // pid from `id` to every row, on every platform, rather than only where a
    // collision happens to occur.
    printf("[");
    for (size_t i = 0; i < entries.size(); i++) {
        const Entry& e = entries[i];
        printf("%s{\"id\":\"pid:%lu\",\"label\":\"%s\",\"exe\":\"%s\",\"active\":%s,\"windows\":[",
               i ? "," : "",
               e.pid,
               JsonEscape(e.label).c_str(),
               JsonEscape(e.exe).c_str(),
               e.active ? "true" : "false");
        for (size_t w = 0; w < e.windows.size(); w++) {
            printf("%s\"%s\"", w ? "," : "", JsonEscape(e.windows[w]).c_str());
        }
        printf("]}");
    }
    printf("]");
    fflush(stdout);

    devices->Release();
    en->Release();
    return 0;
}

// One-shot session meters used only for explicit endpoint opt-in. No PCM,
// process command lines, or window titles are emitted by this mode.
static int ListRenderSessions() {
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&en))) {
        printf("[]"); return 0;
    }
    IMMDeviceCollection* devices = nullptr;
    if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) {
        printf("[]"); en->Release(); return 0;
    }
    const ProcessTable procs = BuildProcessTable();
    struct MeterRow {
        std::string endpointId, endpointLabel, exe, rootExe;
        DWORD pid = 0, rootPid = 0;
        bool active = false, sharedKnown = false, shared = false, peakKnown = false, system = false;
        float peak = 0;
        IAudioMeterInformation* meter = nullptr;
    };
    std::vector<MeterRow> rows;
    UINT n = 0; devices->GetCount(&n);
    for (UINT d = 0; d < n; ++d) {
        IMMDevice* dev = nullptr; if (FAILED(devices->Item(d, &dev))) continue;
        LPWSTR rawId = nullptr; std::string endpointId, endpointLabel;
        if (SUCCEEDED(dev->GetId(&rawId)) && rawId) { endpointId = Utf8(rawId); CoTaskMemFree(rawId); }
        IPropertyStore* props = nullptr;
        if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
            PROPVARIANT value; PropVariantInit(&value);
            if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR && value.pwszVal)
                endpointLabel = Utf8(value.pwszVal);
            PropVariantClear(&value); props->Release();
        }
        IAudioSessionManager2* mgr = nullptr;
        if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr))) {
            IAudioSessionEnumerator* sessions = nullptr; int count = 0;
            if (SUCCEEDED(mgr->GetSessionEnumerator(&sessions))) sessions->GetCount(&count);
            for (int i = 0; i < count; ++i) {
                IAudioSessionControl* ctl = nullptr; if (FAILED(sessions->GetSession(i, &ctl))) continue;
                IAudioSessionControl2* ctl2 = nullptr;
                if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctl2))) {
                    MeterRow row{}; HRESULT pidHr = ctl2->GetProcessId(&row.pid);
                    row.endpointId = endpointId; row.endpointLabel = endpointLabel;
                    row.shared = pidHr == static_cast<HRESULT>(0x0889000D) || pidHr == static_cast<HRESULT>(0x8889000D);
                    row.sharedKnown = SUCCEEDED(pidHr) || row.shared;
                    row.system = (pidHr == S_OK && row.pid == 0) || ctl2->IsSystemSoundsSession() == S_OK;
                    row.exe = ImageOf(row.pid, procs);
                    row.rootPid = row.pid ? AppRootPid(row.pid, procs) : 0;
                    row.rootExe = ImageOf(row.rootPid, procs);
                    AudioSessionState state = AudioSessionStateInactive;
                    row.active = SUCCEEDED(ctl->GetState(&state)) && state == AudioSessionStateActive;
                    ctl->QueryInterface(__uuidof(IAudioMeterInformation), (void**)&row.meter);
                    rows.push_back(row); ctl2->Release();
                }
                ctl->Release();
            }
            if (sessions) sessions->Release(); mgr->Release();
        }
        dev->Release();
    }
    for (int sample = 0; sample < 4; ++sample) {
        for (auto& row : rows) if (row.meter) {
            float value = 0;
            if (SUCCEEDED(row.meter->GetPeakValue(&value)) && value >= 0.0f && value <= 1.0f) {
                if (!row.peakKnown || value > row.peak) row.peak = value;
                row.peakKnown = true;
            }
        }
        if (sample < 3) Sleep(75);
    }
    printf("[");
    for (size_t i = 0; i < rows.size(); ++i) {
        const auto& r = rows[i];
        printf("%s{\"endpointId\":\"%s\",\"endpointLabel\":\"%s\",\"pid\":%lu,\"exe\":\"%s\",\"rootPid\":%lu,\"rootExe\":\"%s\",\"active\":%s,\"shared\":%s,\"peak\":%s,\"system\":%s}",
            i ? "," : "", JsonEscape(r.endpointId).c_str(), JsonEscape(r.endpointLabel).c_str(),
            (unsigned long)r.pid, JsonEscape(r.exe).c_str(), (unsigned long)r.rootPid, JsonEscape(r.rootExe).c_str(),
            r.active ? "true" : "false", r.sharedKnown ? (r.shared ? "true" : "false") : "null",
            r.peakKnown ? std::to_string(r.peak).c_str() : "null", r.system ? "true" : "false");
    }
    printf("]"); fflush(stdout);
    for (auto& row : rows) if (row.meter) row.meter->Release();
    devices->Release(); en->Release(); return 0;
}

// PKEY_AudioEndpoint_FormFactor lives in mmdeviceapi.h, which is included above
// without initguid.h, so that header only declares the key. The fmtid and pid
// are the documented ones.
static const PROPERTYKEY kFormFactorKey = {
    {0x1da5d803, 0xd492, 0x4edd, {0x8c, 0x23, 0xe0, 0xc0, 0xff, 0xee, 0x7f, 0x0e}}, 0};

// Reads one string property; null when the endpoint does not have it.
static bool ReadStringProp(IPropertyStore* props, const PROPERTYKEY& key, std::string* out) {
    PROPVARIANT v;
    PropVariantInit(&v);
    bool ok = false;
    if (SUCCEEDED(props->GetValue(key, &v)) && v.vt == VT_LPWSTR && v.pwszVal) {
        *out = Utf8(v.pwszVal);
        ok = true;
    }
    PropVariantClear(&v);
    return ok;
}

static bool ReadUIntProp(IPropertyStore* props, const PROPERTYKEY& key, unsigned long* out) {
    PROPVARIANT v;
    PropVariantInit(&v);
    bool ok = false;
    if (SUCCEEDED(props->GetValue(key, &v)) && v.vt == VT_UI4) {
        *out = v.ulVal;
        ok = true;
    }
    PropVariantClear(&v);
    return ok;
}

// Keep endpoint capture fail-closed. IMMDevice lists software and virtual
// endpoints alongside hardware; only known physical bus enumerators qualify.
static bool IsPhysicalEndpoint(const std::string& enumerator, const std::string& label, const std::string& id) {
    const std::string known[] = {"HDAUDIO", "INTELAUDIO", "USB", "BTHENUM", "BTHHFENUM", "PCI", "ACPI"};
    // Intel SoundWire laptop speakers report the exact SOUNDWIRE enumerator.
    const bool knownBus = _stricmp(enumerator.c_str(), "SOUNDWIRE") == 0 ||
        std::any_of(std::begin(known), std::end(known), [&](const auto& prefix) {
            return _strnicmp(enumerator.c_str(), prefix.c_str(), prefix.size()) == 0;
        });
    if (!knownBus) return false;
    std::string identity = enumerator + " " + label + " " + id;
    std::transform(identity.begin(), identity.end(), identity.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const char* virtualMarkers[] = {"virtual", "vb-audio", "voicemeeter", "cable input", "cable in"};
    for (const char* marker : virtualMarkers) if (identity.find(marker) != std::string::npos) return false;
    return true;
}

// The physical device behind an endpoint, found the way Chromium's
// GetDeviceInstanceId finds it (media/audio/win/device_enumeration_win.cc):
// the node the topology's first connector leads to, and that node's
// PKEY_Device_InstanceId, e.g. "USB\VID_0951&PID_16A4&MI_00\...". Empty when
// any step fails, as in Chromium, which then appends nothing.
static std::string DeviceInstanceId(IMMDevice* dev, IMMDeviceEnumerator* en) {
    std::string out;
    IDeviceTopology* topology = nullptr;
    IConnector* connector = nullptr;
    LPWSTR filterId = nullptr;
    if (SUCCEEDED(dev->Activate(__uuidof(IDeviceTopology), CLSCTX_ALL, nullptr, (void**)&topology)) &&
        SUCCEEDED(topology->GetConnector(0, &connector)) &&
        SUCCEEDED(connector->GetDeviceIdConnectedTo(&filterId)) && filterId) {
        IMMDevice* node = nullptr;
        IPropertyStore* props = nullptr;
        if (SUCCEEDED(en->GetDevice(filterId, &node)) && SUCCEEDED(node->OpenPropertyStore(STGM_READ, &props))) {
            ReadStringProp(props, PKEY_Device_InstanceId, &out);
        }
        if (props) props->Release();
        if (node) node->Release();
    }
    if (filterId) CoTaskMemFree(filterId);
    if (connector) connector->Release();
    if (topology) topology->Release();
    return out;
}

// The suffix Chromium appends to an output's friendly name, from the instance
// id above, as its GetDeviceSuffixWin builds it: USB gives the vendor and
// product ids in lower case, " (0951:16a4)"; Bluetooth gives " (Bluetooth)";
// anything else gives nothing.
static std::string ChromiumLabelSuffix(const std::string& id) {
    if (id.size() >= 21 && id.compare(0, 8, "USB\\VID_") == 0 && id.compare(12, 5, "&PID_") == 0) {
        std::string ids = id.substr(8, 4) + ":" + id.substr(17, 4);
        for (char& c : ids) {
            if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        }
        return " (" + ids + ")";
    }
    if (id.compare(0, 22, "BTHHFENUM\\BthHFPAudio\\") == 0 || id.compare(0, 8, "BTHENUM\\") == 0) {
        return " (Bluetooth)";
    }
    return std::string();
}

// List the active render endpoints with the form factor and enumerator the
// system states for each, so the caller can tell speakers from headphones.
// Unlike ListSources, a missing enumerator is a failure (exit 1, nothing on
// stdout): an empty array would claim there are no outputs.
static int ListDevices() {
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&en))) {
        return 1;
    }

    IMMDeviceCollection* coll = nullptr;
    if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &coll))) {
        en->Release();
        return 1;
    }

    // The default may be absent (no active output); then no row is default.
    std::wstring defaultId;
    IMMDevice* def = nullptr;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &def))) {
        LPWSTR id = nullptr;
        if (SUCCEEDED(def->GetId(&id)) && id) defaultId = id;
        if (id) CoTaskMemFree(id);
        def->Release();
    }

    UINT count = 0;
    coll->GetCount(&count);
    std::string out = "[";
    bool first = true;
    for (UINT i = 0; i < count; i++) {
        IMMDevice* dev = nullptr;
        if (FAILED(coll->Item(i, &dev))) continue;

        LPWSTR id = nullptr;
        if (FAILED(dev->GetId(&id)) || !id) { dev->Release(); continue; }
        const bool isDefault = !defaultId.empty() && defaultId == id;
        std::string idUtf8 = Utf8(id);
        CoTaskMemFree(id);

        std::string label, enumerator;
        unsigned long form = 0;
        bool hasLabel = false, hasEnumerator = false, hasForm = false;
        IPropertyStore* props = nullptr;
        if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
            hasLabel = ReadStringProp(props, PKEY_Device_FriendlyName, &label);
            hasEnumerator = ReadStringProp(props, PKEY_Device_EnumeratorName, &enumerator);
            hasForm = ReadUIntProp(props, kFormFactorKey, &form);
            props->Release();
        }

        // The browser can only be matched by its label, so build the one it shows.
        const std::string browserLabel = hasLabel ? label + ChromiumLabelSuffix(DeviceInstanceId(dev, en)) : std::string();
        const bool physical = hasEnumerator && IsPhysicalEndpoint(enumerator, label, idUtf8);

        if (!first) out += ",";
        first = false;
        out += "{\"id\":\"" + JsonEscape(idUtf8) + "\",\"label\":\"" + JsonEscape(hasLabel ? label : std::string()) +
               "\",\"browserLabel\":\"" + JsonEscape(browserLabel) + "\",\"isDefault\":" + (isDefault ? "true" : "false") + ",\"formFactor\":";
        out += hasForm ? std::to_string(form) : std::string("null");
        out += ",\"enumerator\":";
        out += hasEnumerator ? "\"" + JsonEscape(enumerator) + "\"" : std::string("null");
        out += ",\"physical\":" + std::string(physical ? "true" : "false");
        out += "}";
        dev->Release();
    }
    out += "]";
    fwrite(out.data(), 1, out.size(), stdout);
    fflush(stdout);

    coll->Release();
    en->Release();
    return 0;
}

// ------------------------------------------------------------------ capture

class ActivateHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HRESULT activateHr = E_FAIL;
    IAudioClient* client = nullptr;

    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        IUnknown* unk = nullptr;
        HRESULT hrResult = E_FAIL;
        HRESULT hr = op->GetActivateResult(&hrResult, &unk);
        activateHr = SUCCEEDED(hr) ? hrResult : hr;
        if (SUCCEEDED(activateHr) && unk) {
            unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
        }
        if (unk) unk->Release();
        SetEvent(done);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            return S_OK;
        }
        // Without IAgileObject the callback cannot marshal and activation hangs.
        if (riid == __uuidof(IAgileObject)) { *ppv = this; return S_OK; }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
};

static volatile BOOL g_stop = FALSE;

static BOOL WINAPI OnConsoleCtrl(DWORD) {
    g_stop = TRUE;
    return TRUE;
}

// Check for queued packets even on timeout. An invalidated loopback endpoint
// can stop signalling its event; the error must reach Electron so it can rebind.
static bool WaitForCaptureTick(HANDLE ready) {
    const DWORD wait = WaitForSingleObject(ready, 500);
    return wait == WAIT_OBJECT_0 || wait == WAIT_TIMEOUT;
}

static int CaptureClient(IAudioClient* client, HANDLE target) {
    HANDLE ready = nullptr;
    IAudioCaptureClient* cap = nullptr;
    bool started = false;
    int rc = 1;
    static const char kZeros[8192] = {};
    const UINT32 blockAlign = kChannels * kBits / 8;
    WAVEFORMATEX fmt{};
    fmt.wFormatTag = WAVE_FORMAT_PCM;
    fmt.nChannels = kChannels;
    fmt.nSamplesPerSec = kSampleRate;
    fmt.wBitsPerSample = kBits;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

    HRESULT hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        0, 0, &fmt, nullptr);
    if (FAILED(hr)) { EmitError("initialize_failed"); goto cleanup; }

    ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!ready || FAILED(client->SetEventHandle(ready))) { EmitError("initialize_failed"); goto cleanup; }

    if (FAILED(client->GetService(__uuidof(IAudioCaptureClient), (void**)&cap))) {
        EmitError("initialize_failed"); goto cleanup;
    }

    if (FAILED(client->Start())) { EmitError("initialize_failed"); goto cleanup; }
    started = true;
    rc = 0;

    EmitEvent("{\"event\":\"format\",\"sampleRate\":24000,\"channels\":1,\"encoding\":\"s16le\"}");

    while (!g_stop) {
        if (target && WaitForSingleObject(target, 0) == WAIT_OBJECT_0) {
            EmitError("target_gone");
            rc = 1;
            break;
        }
        if (!WaitForCaptureTick(ready)) { EmitError("initialize_failed"); rc = 1; break; }

        for (;;) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            hr = cap->GetNextPacketSize(&frames);
            if (FAILED(hr)) { EmitError("initialize_failed"); rc = 1; g_stop = TRUE; break; }
            if (frames == 0) break;
            hr = cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                // Endpoint changes and driver failures invalidate the stream;
                // report loss so the caller can release it and retry cleanly.
                EmitError("initialize_failed");
                rc = 1;
                g_stop = TRUE;
                break;
            }
            if (hr == AUDCLNT_S_BUFFER_EMPTY) break;

            size_t bytes = static_cast<size_t>(frames) * blockAlign;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                // The buffer contents are undefined under this flag. Write real
                // zeros, and never skip the write: downstream timing assumes
                // every buffer is forwarded.
                size_t remaining = bytes;
                while (remaining > 0) {
                    size_t chunk = remaining < sizeof(kZeros) ? remaining : sizeof(kZeros);
                    fwrite(kZeros, 1, chunk, stdout);
                    remaining -= chunk;
                }
            } else {
                fwrite(data, 1, bytes, stdout);
            }
            cap->ReleaseBuffer(frames);

            // The parent reads this pipe live; without a flush the audio arrives
            // in stdio-buffer-sized bursts and adds latency.
            if (fflush(stdout) != 0) { g_stop = TRUE; break; }  // parent closed the pipe
        }
    }

cleanup:
    if (started) client->Stop();
    if (cap) cap->Release();
    if (ready) CloseHandle(ready);
    return rc;
}

// Endpoint loopback supplies the endpoint mix format. Keep the decoder explicit
// instead of assuming it matches the format requested by a process-loopback
// client: endpoint drivers commonly expose float32 or multichannel PCM.
struct EndpointMixDecoder {
    UINT32 rate = 0;
    WORD channels = 0;
    WORD bits = 0;
    WORD validBits = 0;
    bool floatingPoint = false;
    UINT32 blockAlign = 0;
    double windowRemaining = 0;
    double windowSum = 0;
    double inputPerOutput = 0;

    bool Configure(const WAVEFORMATEX* fmt) {
        if (!fmt || fmt->nSamplesPerSec == 0 || fmt->nChannels == 0 || fmt->nBlockAlign == 0) return false;
        rate = fmt->nSamplesPerSec;
        channels = fmt->nChannels;
        blockAlign = fmt->nBlockAlign;
        bits = fmt->wBitsPerSample;
        validBits = bits;
        WORD tag = fmt->wFormatTag;
        if (tag == WAVE_FORMAT_EXTENSIBLE) {
            if (fmt->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) return false;
            const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
            const GUID& sub = ext->SubFormat;
            const bool pcm = sub.Data1 == WAVE_FORMAT_PCM && sub.Data2 == 0 && sub.Data3 == 0x0010
                && sub.Data4[0] == 0x80 && sub.Data4[1] == 0x00 && sub.Data4[2] == 0x00
                && sub.Data4[3] == 0xaa && sub.Data4[4] == 0x00 && sub.Data4[5] == 0x38
                && sub.Data4[6] == 0x9b && sub.Data4[7] == 0x71;
            const bool ieee = sub.Data1 == WAVE_FORMAT_IEEE_FLOAT && sub.Data2 == 0 && sub.Data3 == 0x0010
                && sub.Data4[0] == 0x80 && sub.Data4[1] == 0x00 && sub.Data4[2] == 0x00
                && sub.Data4[3] == 0xaa && sub.Data4[4] == 0x00 && sub.Data4[5] == 0x38
                && sub.Data4[6] == 0x9b && sub.Data4[7] == 0x71;
            if (!pcm && !ieee) return false;
            floatingPoint = ieee;
            validBits = ext->Samples.wValidBitsPerSample;
            if (validBits == 0) validBits = bits;
        } else if (tag == WAVE_FORMAT_IEEE_FLOAT) {
            floatingPoint = true;
        } else if (tag != WAVE_FORMAT_PCM) {
            return false;
        }
        if (floatingPoint) {
            if (bits != 32) return false;
        } else if ((bits != 16 && bits != 24 && bits != 32) || validBits == 0 || validBits > bits) {
            return false;
        }
        const UINT32 bytesPerSample = (bits + 7) / 8;
        if (blockAlign < static_cast<UINT32>(channels) * bytesPerSample) return false;
        inputPerOutput = static_cast<double>(rate) / static_cast<double>(kSampleRate);
        windowRemaining = inputPerOutput;
        return inputPerOutput > 0;
    }

    double DecodeSample(const BYTE* p) const {
        if (floatingPoint) {
            float value = 0;
            memcpy(&value, p, sizeof(value));
            return std::isfinite(value) ? std::max(-1.0, std::min(1.0, static_cast<double>(value))) : 0.0;
        }
        int64_t value = 0;
        if (bits == 16) {
            int16_t v = 0; memcpy(&v, p, sizeof(v)); value = v;
        } else if (bits == 24) {
            value = static_cast<int32_t>(static_cast<uint32_t>(p[0])
                | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16));
            if (value & 0x800000) value |= ~static_cast<int64_t>(0xFFFFFF);
        } else {
            int32_t v = 0; memcpy(&v, p, sizeof(v)); value = v;
        }
        const WORD shift = bits - validBits;
        if (shift) value >>= shift;
        return static_cast<double>(value) / std::ldexp(1.0, validBits - 1);
    }

    void Convert(const BYTE* data, UINT32 frames, bool silent, std::vector<int16_t>* out) {
        const UINT32 bytesPerSample = (bits + 7) / 8;
        for (UINT32 frame = 0; frame < frames; ++frame) {
            double mono = 0;
            if (!silent) {
                const BYTE* base = data + static_cast<size_t>(frame) * blockAlign;
                for (WORD channel = 0; channel < channels; ++channel) {
                    mono += DecodeSample(base + static_cast<size_t>(channel) * bytesPerSample);
                }
                mono /= channels;
            }

            // Stateful box resampling. Each input frame spans one source-rate
            // unit; output windows span rate/24000 units, and partial windows
            // carry across WASAPI buffers. For downsampling this averages each
            // covered interval, reducing aliasing without external libraries.
            double frameRemaining = 1.0;
            while (frameRemaining > 1e-12) {
                const double take = std::min(frameRemaining, windowRemaining);
                windowSum += mono * take;
                frameRemaining -= take;
                windowRemaining -= take;
                if (windowRemaining <= 1e-12) {
                    const double normalized = std::max(-1.0, std::min(1.0, windowSum / inputPerOutput));
                    const double scaled = normalized < 0 ? normalized * 32768.0 : normalized * 32767.0;
                    out->push_back(static_cast<int16_t>(std::lrint(scaled)));
                    windowSum = 0;
                    windowRemaining = inputPerOutput;
                }
            }
        }
    }
};

static int CaptureEndpointClient(IAudioClient* client) {
    HANDLE ready = nullptr;
    IAudioCaptureClient* cap = nullptr;
    WAVEFORMATEX* mixFormat = nullptr;
    bool started = false;
    int rc = 1;
    EndpointMixDecoder decoder;

    HRESULT hr = client->GetMixFormat(&mixFormat);
    if (FAILED(hr) || !mixFormat || !decoder.Configure(mixFormat)) {
        EmitError("unsupported_mix_format");
        goto cleanup;
    }
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        0, 0, mixFormat, nullptr);
    if (FAILED(hr)) { EmitError("initialize_failed"); goto cleanup; }

    ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!ready || FAILED(client->SetEventHandle(ready))) { EmitError("initialize_failed"); goto cleanup; }
    if (FAILED(client->GetService(__uuidof(IAudioCaptureClient), (void**)&cap))) {
        EmitError("initialize_failed"); goto cleanup;
    }
    if (FAILED(client->Start())) { EmitError("initialize_failed"); goto cleanup; }
    started = true;
    rc = 0;
    EmitEvent("{\"event\":\"format\",\"sampleRate\":24000,\"channels\":1,\"encoding\":\"s16le\"}");

    while (!g_stop) {
        if (!WaitForCaptureTick(ready)) { EmitError("initialize_failed"); rc = 1; break; }
        for (;;) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            hr = cap->GetNextPacketSize(&frames);
            if (FAILED(hr)) { EmitError("initialize_failed"); rc = 1; g_stop = TRUE; break; }
            if (frames == 0) break;
            hr = cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                EmitError("initialize_failed"); rc = 1; g_stop = TRUE; break;
            }
            if (hr == AUDCLNT_S_BUFFER_EMPTY) break;
            std::vector<int16_t> pcm;
            pcm.reserve(static_cast<size_t>(frames) * kSampleRate / decoder.rate + 2);
            decoder.Convert(data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0, &pcm);
            cap->ReleaseBuffer(frames);
            if (!pcm.empty()) {
                fwrite(pcm.data(), sizeof(int16_t), pcm.size(), stdout);
                if (fflush(stdout) != 0) { g_stop = TRUE; break; }
            }
        }
    }

cleanup:
    if (started) client->Stop();
    if (cap) cap->Release();
    if (ready) CloseHandle(ready);
    if (mixFormat) CoTaskMemFree(mixFormat);
    return rc;
}

static int Capture(DWORD pid) {
    // Keep a handle so we can tell "the app quit" from "the app went quiet".
    HANDLE target = OpenProcess(SYNCHRONIZE, FALSE, pid);

    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    // Browsers and Electron apps render audio from a child process, so the whole
    // tree must be included or a Chrome tab's audio is missed entirely.
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT pv{};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ActivateHandler handler;
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                             __uuidof(IAudioClient), &pv, &handler, &op);
    if (FAILED(hr)) { CloseHandle(target); EmitError("activation_failed"); return 1; }

    int rc = 1;
    if (WaitForSingleObject(handler.done, 5000) != WAIT_OBJECT_0 ||
        FAILED(handler.activateHr) || !handler.client) {
        EmitError("activation_failed");
    } else {
        rc = CaptureClient(handler.client, target);
    }

    if (op) op->Release();
    if (handler.client) handler.client->Release();
    if (handler.done) CloseHandle(handler.done);
    CloseHandle(target);
    return rc;
}

static int CaptureSystem() {
    IMMDeviceEnumerator* en = nullptr;
    IMMDevice* endpoint = nullptr;
    IAudioClient* client = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  __uuidof(IMMDeviceEnumerator), (void**)&en);
    if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eMultimedia, &endpoint);
    if (SUCCEEDED(hr)) hr = endpoint->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);

    int rc = 1;
    if (FAILED(hr) || !client) {
        EmitError("activation_failed");
    } else {
        rc = CaptureClient(client, nullptr);
    }

    if (client) client->Release();
    if (endpoint) endpoint->Release();
    if (en) en->Release();
    return rc;
}

static int CaptureEndpoint(const wchar_t* id) {
    IMMDeviceEnumerator* en = nullptr;
    IMMDevice* endpoint = nullptr;
    IAudioClient* client = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  __uuidof(IMMDeviceEnumerator), (void**)&en);
    if (SUCCEEDED(hr)) hr = en->GetDevice(id, &endpoint);
    if (FAILED(hr) || !endpoint) {
        EmitError("endpoint_not_found");
        if (en) en->Release();
        return 1;
    }

    DWORD state = 0;
    IMMEndpoint* endpointInfo = nullptr;
    hr = endpoint->GetState(&state);
    if (SUCCEEDED(hr)) hr = endpoint->QueryInterface(__uuidof(IMMEndpoint), (void**)&endpointInfo);
    EDataFlow flow = eAll;
    if (SUCCEEDED(hr)) hr = endpointInfo->GetDataFlow(&flow);
    if (endpointInfo) endpointInfo->Release();
    if (FAILED(hr) || state != DEVICE_STATE_ACTIVE || flow != eRender) {
        EmitError(state != DEVICE_STATE_ACTIVE ? "endpoint_not_active" : "endpoint_not_render");
        endpoint->Release(); en->Release(); return 1;
    }

    std::string enumerator;
    IPropertyStore* props = nullptr;
    std::string label, endpointId;
    LPWSTR endpointIdWide = nullptr;
    if (SUCCEEDED(endpoint->GetId(&endpointIdWide)) && endpointIdWide) {
        endpointId = Utf8(endpointIdWide);
        CoTaskMemFree(endpointIdWide);
    }
    const bool hasProps = SUCCEEDED(endpoint->OpenPropertyStore(STGM_READ, &props));
    bool hasEnumerator = false;
    if (hasProps) {
        hasEnumerator = ReadStringProp(props, PKEY_Device_EnumeratorName, &enumerator);
        ReadStringProp(props, PKEY_Device_FriendlyName, &label);
    }
    if (props) props->Release();
    if (!hasEnumerator || !IsPhysicalEndpoint(enumerator, label, endpointId)) {
        EmitError("endpoint_unsupported");
        endpoint->Release(); en->Release(); return 1;
    }

    hr = endpoint->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
    int rc = 1;
    if (FAILED(hr) || !client) EmitError("activation_failed");
    else rc = CaptureEndpointClient(client);
    if (client) client->Release();
    endpoint->Release();
    en->Release();
    return rc;
}

// --------------------------------------------------------------------- main

static void Usage() {
    fprintf(stderr,
        "usage:\n"
        "  sokuji-audio-host.exe --list\n"
        "  sokuji-audio-host.exe --devices\n"
        "  sokuji-audio-host.exe --sessions\n"
        "  sokuji-audio-host.exe --target pid:<processId>|system|endpoint:<IMMDevice id>\n");
}

int wmain(int argc, wchar_t** argv) {
    // PCM must not be newline-translated; 0x0A bytes are ordinary sample data.
    _setmode(_fileno(stdout), _O_BINARY);

    if (argc < 2) { Usage(); return 2; }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) { EmitError("activation_failed"); return 1; }

    int rc = 2;
    g_stop = FALSE;
    if (wcscmp(argv[1], L"--list") == 0) {
        rc = ListSources();
    } else if (wcscmp(argv[1], L"--devices") == 0) {
        rc = ListDevices();
    } else if (wcscmp(argv[1], L"--sessions") == 0) {
        rc = ListRenderSessions();
    } else if (wcscmp(argv[1], L"--target") == 0 && argc >= 3) {
        SetConsoleCtrlHandler(OnConsoleCtrl, TRUE);
        if (wcscmp(argv[2], L"system") == 0) {
            rc = CaptureSystem();
        } else if (wcsncmp(argv[2], L"endpoint:", 9) == 0 && argv[2][9] != L'\0') {
            rc = CaptureEndpoint(argv[2] + 9);
        } else if (wcsncmp(argv[2], L"pid:", 4) != 0) { EmitError("bad_target"); rc = 2; }
        else {
            DWORD pid = static_cast<DWORD>(_wtoi(argv[2] + 4));
            if (pid == 0) { EmitError("bad_target"); rc = 2; }
            else rc = Capture(pid);
        }
    } else {
        Usage();
        rc = 2;
    }

    CoUninitialize();
    return rc;
}
