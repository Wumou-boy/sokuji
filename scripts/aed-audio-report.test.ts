// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')('runs the shipped report version check on release and prerelease Windows product metadata', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aed-report-version-'));
  try {
    const cmd = path.join(dir, 'AED-Audio-Report.cmd');
    execFileSync(process.execPath, ['scripts/build-aed-audio-report.cjs', cmd]);
    const embedded = readFileSync(cmd, 'utf8').split('# AED_REPORT_PS\r\n')[1].split('# AED_REPORT_WAV\r\n')[0];
    const ps = `
      $source = [Console]::In.ReadToEnd()
      $tokens=$null; $errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
      if ($errors.Count) {throw $errors[0]}
      $gate=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-AedReportProduct'},$true)
      $expected=@($false,$true,$true,$true,$true,$false)
      $cases=@('0.2.5','0.2.6','0.2.8','0.3.0-beta.5','0.4.0','0.3.0')
      for ($i=0; $i -lt $cases.Count; $i++) {
        $version=$cases[$i]
        $core=[version]($version.Split('-')[0])
        $product=if ($i -eq 5) {'Other'} else {'AED Translator'}
        $VersionInfo=[pscustomobject]@{ProductName=$product; ProductVersion=$version; ProductMajorPart=$core.Major; ProductMinorPart=$core.Minor; ProductBuildPart=$core.Build}
        $accepted=& $gate.Body.GetScriptBlock()
        if ($accepted -ne $expected[$i]) {throw ('Wrong result for '+$product+' '+$version)}
      }
      Write-Output 'passed'
    `;
    expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      input: embedded, encoding: 'utf8', windowsHide: true,
    }).trim()).toBe('passed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
