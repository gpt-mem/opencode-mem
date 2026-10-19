# Windows setup for the son's first OpenCode user

This package prepares a Windows CLI build of this fork (`gpt-mem/opencode-mem`) with an unrestricted local configuration.

## What is included

- `.github/workflows/windows-build.yml` - GitHub Actions workflow that builds `opencode-windows-x64`, runs a smoke test, zips it, and optionally creates a draft release.
- `script/windows/install-windows.ps1` - PowerShell installer for Windows.
- `script/windows/opencode.windows.jsonc` - unrestricted config template (`permission: allow`).

## Build and verify in GitHub Actions

1. Push this repository (or a branch) to GitHub.
2. Open the repository on GitHub -> Actions -> `windows-build`.
3. Click `Run workflow`.
4. Optional inputs:
   - `version`: a label such as `1.18.34-son`.
   - `baseline`: enable only for machines without AVX2.
   - `create_release`: enable to publish a draft release with the Windows zip.
5. Wait for the `Build Windows CLI` and `Smoke test binary` steps to finish.
6. Download the `opencode-windows-x64` artifact or use the generated release.

## Install on the son's Windows machine

PowerShell (run as the son's user, not Administrator):

```powershell
irm https://raw.githubusercontent.com/gpt-mem/opencode-mem/dev/script/windows/install-windows.ps1 | iex
```

Or from a local checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\script\windows\install-windows.ps1
```

Install from a manually downloaded binary:

```powershell
.\script\windows\install-windows.ps1 -BinaryPath C:\path\to\opencode.exe
```

Install a specific release version:

```powershell
.\script\windows\install-windows.ps1 -Version 1.18.34-son
```

## Add the API key

The installer does not store keys in the repository. Set the key on the son's machine:

```powershell
setx OPENAI_API_KEY "sk-..."
```

Restart the terminal after `setx`. For Anthropic, Google, or another provider, use the provider's environment variable or `opencode auth login`.

## Unrestricted mode

The generated config uses:

```jsonc
{
  "permission": "allow",
}
```

This allows file reads/writes, bash, edits, external directories, and other tools without approval prompts. Keep this only on a machine you trust.

## Switch models or providers

- Edit `%USERPROFILE%\.config\opencode\opencode.jsonc`.
- Or run `opencode auth login` and choose a provider.
- Or set provider environment variables and restart OpenCode.
- To switch back to a restricted mode, change `"permission": "allow"` to `"permission": "ask"` or remove the key.

## Update

Re-run the installer. It overwrites `opencode.exe` and keeps the existing config unless the config file is missing.

## Troubleshooting

- If `opencode` is not found, restart the terminal or add `%USERPROFILE%\.opencode\bin` to PATH manually.
- If SmartScreen blocks the binary, use a signed build or run from the downloaded artifact.
- If the machine has no AVX2 support, rebuild with `baseline: true` and install that zip.
- For Google Cloud storage instead of GitHub Releases, upload the zip to a bucket and change the installer's `$downloadUrl`.

## Google Cloud option

GitHub Actions is enough for verification. If you later want Google Cloud:

1. Store the API key in Secret Manager.
2. Have the installer fetch the key with `gcloud secrets versions access latest --secret=opencode-son-key`.
3. Host the Windows zip in Cloud Storage and point `$downloadUrl` at it.

Do not commit real API keys to this repository.
