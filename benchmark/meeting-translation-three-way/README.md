# Local model benchmark: resource and speech-output proxies

This benchmark compares two archived cloud routes with local synthetic-audio replay on one Windows PC. It does not measure live meetings or Teams end-to-end latency.

## Machine and proxy scope

The local host was a Ryzen 7 9800X3D system with an RTX 5080. The `2 cores / 6 GiB` and `4 cores / 12 GiB` CPU profiles are resource-budget proxies for laptop-class use; both were run on this desktop CPU with Windows core affinity and process memory limits. The RTX 5080 `1/2/4/8` stream profiles are local GPU concurrency proxies for a possible PGX-class deployment discussion. They are not measurements from a ThinkPad or PGX device, and do not predict their hardware performance. No Teams end-to-end, network, or remote playback latency was measured.

The local replay uses repeated synthetic audio at 16 kHz, with fixed 100 ms input chunks. Caption fixtures include English, Japanese, and Chinese; the separate PTT speech sample is Mandarin. Repeated replay observations are not independent speakers or real meetings. No audio, transcripts, fixtures, or raw traces are included in this export.

Translation used Hy-MT2 1.8B Q4_K_M through llama.cpp; recognition used SenseVoiceSmall INT8 with CPU VAD. In the RTX profiles, only translation used CUDA; the replay and recognition workload remained local on the same PC.

## Caption replay: three routes

The cloud rows are archived service measurements from the earlier paired run; this export did not issue new cloud requests. Local rows are offline replay results. All values are milliseconds. First-caption and finalization medians retain their exact sample counts. `Block end to final bilingual` covers all source languages; `EN/JA finalization` reports the English and Japanese subset. Fact counts are synthetic fixture checks, not a general accuracy score.

| Profile | First bilingual block median (n) | Block end to final bilingual median / max (n) | EN/JA end to final median / max (n) | Fixture facts |
| --- | ---: | ---: | ---: | ---: |
| Archived cloud · Qwen 3.8 LiveTranslate | 2149 (3) | 560 / 1517 (12) | 551 / 1517 (9) | 39/39 |
| Archived cloud · Team Token Plan · Audio 3.0 | 4586 (3) | 911 / 1959 (12) | 898 / 1959 (9) | 39/39 |
| Laptop resource proxy · CPU 2 cores / 6 GiB | 4860.26 (3) | 1780.54 / 2305.10 (12) | 1824.20 / 2305.10 (9) | 39/39 |
| Laptop resource proxy · CPU 4 cores / 12 GiB | 4738.35 (3) | 1579.87 / 2365.32 (12) | 1805.27 / 2365.32 (9) | 39/39 |
| PGX discussion proxy · RTX 5080 · 1 stream | 4346.73 (1) | 753.02 / 868.45 (4) | 763.32 / 868.45 (3) | 13/13 |
| PGX discussion proxy · RTX 5080 · 2 streams | 4378.68 (2) | 793.56 / 871.16 (8) | 809.73 / 871.16 (6) | 26/26 |
| PGX discussion proxy · RTX 5080 · 4 streams | 4431.98 (4) | 902.16 / 1061.94 (16) | 929.24 / 1061.94 (12) | 52/52 |
| PGX discussion proxy · RTX 5080 · 8 streams | 4624.66 (8) | 1088.76 / 1417.42 (32) | 1135.52 / 1417.42 (24) | 104/104 |

Each local caption replay profile used a 600 ms pause threshold. GPU concurrency profiles were one replay round; stream counts and observation counts are shown explicitly because repeated segments are correlated observations.

The archived cloud route source and its detailed methodology are documented in [`../qwen-realtime-translation/README.md`](../qwen-realtime-translation/README.md). Cloud PTT timings use service response events, while local PTT timings below use local audio-file availability; these endpoints should not be treated as identical.

## PTT speech output: SAPI and Piper

Local PTT measures start at key release. “Audio available” means a complete local WAV was readable; it does not measure playback through Teams. SAPI and Piper were tested as separate synthesizers using the same synthetic Mandarin input. Five observations were recorded per profile.

| Local profile | Synthesizer | Release to translation final median (n) | Release to complete WAV median (n) | Synthesis time median (n) |
| --- | --- | ---: | ---: | ---: |
| CPU 2 cores / 6 GiB | Microsoft Zira Desktop (Windows SAPI) | 2749.92 (5) | 2786.35 (5) | 45.34 (5) |
| CPU 2 cores / 6 GiB | Piper 1.8.0 · en_US-lessac-low | 2726.16 (5) | 3693.80 (5) | 967.61 (5) |
| CPU 4 cores / 12 GiB | Microsoft Zira Desktop (Windows SAPI) | 3302.03 (5) | 3370.91 (5) | 61.77 (5) |
| CPU 4 cores / 12 GiB | Piper 1.8.0 · en_US-lessac-low | 2255.50 (5) | 2623.18 (5) | 397.00 (5) |
| RTX 5080 · 1 stream | Microsoft Zira Desktop (Windows SAPI) | 303.47 (5) | 329.99 (5) | 26.64 (5) |
| RTX 5080 · 1 stream | Piper 1.8.0 · en_US-lessac-low | 281.61 (5) | 372.21 (5) | 93.25 (5) |

The cloud PTT rows are archived separately: first PCM arrived at a median of 6585 ms before key release for Qwen 3.8 LiveTranslate (`n=3`); Audio 3.0 completed its response at a median of 2378 ms after release (`n=3`). These are service response events, not playback timing. Local synthesis ran on this Windows PC; in the RTX rows, CUDA was used for translation. No voice naturalness evaluation was performed.

A separate simultaneous-release stress replay used the RTX 5080 translation service and one local synthesis process. Every request used the same synthetic Mandarin sample. Median complete-WAV availability was 322.73 ms (n=3) at 1 simultaneous stream, 391.85 ms (n=6) at 2, 583.77 ms (n=12) at 4, and 834.05 ms (n=24) at 8. This is a local synthetic burst test, not a Teams or PGX latency result.

## Data

See [`results.json`](results.json) for the compact machine-readable measurements. Values retain the source summary's millisecond precision. The JSON intentionally omits local paths, credentials, audio, fixtures, transcript samples, and raw traces.
