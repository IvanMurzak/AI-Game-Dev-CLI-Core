import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { dpapiCredentialCodec } from "../src/index.js";

/**
 * Cross-implementation DPAPI parity (unified-machine-auth 04 §1, task x1, Windows CI leg only):
 * proves the TS store's `dpapiCredentialCodec` (which shells out to `powershell.exe` running
 * `[System.Security.Cryptography.ProtectedData]`) and the C# store's `CryptProtectData` /
 * `CryptUnprotectData` P/Invoke codec (`MCP-Plugin-dotnet` `MachineCredentialStore`) are
 * byte-interoperable: a blob written by one is readable by the other, on the SAME machine/user
 * (DPAPI's CurrentUser scope makes a cross-machine committed ciphertext vector meaningless — this
 * is why the proof is a live round-trip, not a static golden file).
 *
 * This file reproduces the C# side's exact mechanism verbatim — the same P/Invoke declarations
 * `MachineCredentialStore.cs` compiles (`CryptProtectData`/`CryptUnprotectData`, the `DATA_BLOB`
 * struct, `CRYPTPROTECT_UI_FORBIDDEN`) — via PowerShell's `Add-Type -TypeDefinition` (Windows
 * PowerShell ships the C# CodeDom compiler), so this repo's CI can prove interop hermetically
 * without installing a .NET SDK. Not a re-implementation of DPAPI conceptually: it is a literal
 * transcription of the shipped C# source, JIT-compiled instead of `dotnet build`-compiled.
 *
 * **Entropy plant (mandated, DoD):** DPAPI's optional entropy parameter must be `null` on BOTH
 * sides — the C# store passes `IntPtr.Zero`, and {@link dpapiCredentialCodec} passes `$null`.
 * `entropy mismatch turns the cross-decrypt RED (both directions)` proves a non-null entropy on
 * EITHER side breaks the round trip — verified RED locally before this suite shipped (see the x1
 * task report for the exact mutation and failure output).
 */

const isWindows = process.platform === "win32";

/**
 * Verbatim transcription of `MCP-Plugin-dotnet/McpPlugin/src/AgentConfig/MachineCredentialStore.cs`'s
 * `Protect`/`Unprotect` P/Invoke declarations — the REAL mechanism the C# store uses. Compiled and
 * invoked via PowerShell's `Add-Type` so this repo can prove interop without a .NET toolchain in CI.
 */
const CSHARP_SHAPE_TYPE_DEFINITION = `
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace AigdInterop
{
    [StructLayout(LayoutKind.Sequential)]
    public struct DATA_BLOB
    {
        public int cbData;
        public IntPtr pbData;
    }

    public static class Dpapi
    {
        private const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string szDataDescr,
            IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr,
            IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr hMem);

        public static byte[] Protect(byte[] data, byte[] entropy)
        {
            var inBlob = new DATA_BLOB();
            var outBlob = new DATA_BLOB();
            var entropyBlob = new DATA_BLOB();
            try
            {
                inBlob.pbData = Marshal.AllocHGlobal(data.Length);
                inBlob.cbData = data.Length;
                Marshal.Copy(data, 0, inBlob.pbData, data.Length);

                IntPtr entropyPtr = IntPtr.Zero;
                if (entropy != null && entropy.Length > 0)
                {
                    entropyBlob.pbData = Marshal.AllocHGlobal(entropy.Length);
                    entropyBlob.cbData = entropy.Length;
                    Marshal.Copy(entropy, 0, entropyBlob.pbData, entropy.Length);
                    entropyPtr = Marshal.AllocHGlobal(Marshal.SizeOf(entropyBlob));
                    Marshal.StructureToPtr(entropyBlob, entropyPtr, false);
                }

                if (!CryptProtectData(ref inBlob, "ai-game-dev credentials", entropyPtr, IntPtr.Zero,
                        IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref outBlob))
                    throw new CryptographicException(Marshal.GetLastWin32Error());

                var result = new byte[outBlob.cbData];
                Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
                if (entropyPtr != IntPtr.Zero) Marshal.FreeHGlobal(entropyPtr);
                if (entropyBlob.pbData != IntPtr.Zero) Marshal.FreeHGlobal(entropyBlob.pbData);
                return result;
            }
            finally
            {
                if (inBlob.pbData != IntPtr.Zero) Marshal.FreeHGlobal(inBlob.pbData);
                if (outBlob.pbData != IntPtr.Zero) LocalFree(outBlob.pbData);
            }
        }

        public static byte[] Unprotect(byte[] data, byte[] entropy)
        {
            var inBlob = new DATA_BLOB();
            var outBlob = new DATA_BLOB();
            var entropyBlob = new DATA_BLOB();
            try
            {
                inBlob.pbData = Marshal.AllocHGlobal(data.Length);
                inBlob.cbData = data.Length;
                Marshal.Copy(data, 0, inBlob.pbData, data.Length);

                IntPtr entropyPtr = IntPtr.Zero;
                if (entropy != null && entropy.Length > 0)
                {
                    entropyBlob.pbData = Marshal.AllocHGlobal(entropy.Length);
                    entropyBlob.cbData = entropy.Length;
                    Marshal.Copy(entropy, 0, entropyBlob.pbData, entropy.Length);
                    entropyPtr = Marshal.AllocHGlobal(Marshal.SizeOf(entropyBlob));
                    Marshal.StructureToPtr(entropyBlob, entropyPtr, false);
                }

                if (!CryptUnprotectData(ref inBlob, IntPtr.Zero, entropyPtr, IntPtr.Zero,
                        IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref outBlob))
                    throw new CryptographicException(Marshal.GetLastWin32Error());

                var result = new byte[outBlob.cbData];
                Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
                if (entropyPtr != IntPtr.Zero) Marshal.FreeHGlobal(entropyPtr);
                if (entropyBlob.pbData != IntPtr.Zero) Marshal.FreeHGlobal(entropyBlob.pbData);
                return result;
            }
            finally
            {
                if (inBlob.pbData != IntPtr.Zero) Marshal.FreeHGlobal(inBlob.pbData);
                if (outBlob.pbData != IntPtr.Zero) LocalFree(outBlob.pbData);
            }
        }
    }
}
`.trim();

/** Run the C#-shape helper's Protect/Unprotect via PowerShell Add-Type. `entropy` is null-entropy when omitted. */
function runCSharpShapeDpapi(action: "Protect" | "Unprotect", input: Buffer, entropy?: Buffer): Buffer {
  const script =
    "$ErrorActionPreference='Stop';" +
    `Add-Type -TypeDefinition @'\n${CSHARP_SHAPE_TYPE_DEFINITION}\n'@;` +
    "$in=[Convert]::FromBase64String($env:AIGD_IN);" +
    (entropy ? "$entropy=[Convert]::FromBase64String($env:AIGD_ENTROPY);" : "$entropy=$null;") +
    `$out=[AigdInterop.Dpapi]::${action}($in,$entropy);` +
    "[Convert]::ToBase64String($out)";

  const stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIGD_IN: input.toString("base64"),
      ...(entropy ? { AIGD_ENTROPY: entropy.toString("base64") } : {}),
    },
    timeout: 30_000,
  });
  return Buffer.from(stdout.trim(), "base64");
}

const SAMPLE_PLAINTEXT = Buffer.from(
  JSON.stringify({ accessToken: "dpapi-cross-impl-AT", refreshToken: "dpapi-cross-impl-RT" }),
  "utf-8",
);

describe.skipIf(!isWindows)("DPAPI cross-implementation parity (C# interop shape, x1)", () => {
  it("TS-encrypted blob is decryptable by the C#-shape helper", { timeout: 30_000 }, () => {
    const ciphertext = dpapiCredentialCodec.encrypt(SAMPLE_PLAINTEXT);
    const recovered = runCSharpShapeDpapi("Unprotect", ciphertext);
    expect(recovered.equals(SAMPLE_PLAINTEXT)).toBe(true);
  });

  it("a C#-shape-encrypted blob is decryptable by the TS codec", { timeout: 30_000 }, () => {
    const ciphertext = runCSharpShapeDpapi("Protect", SAMPLE_PLAINTEXT);
    const recovered = dpapiCredentialCodec.decrypt(ciphertext);
    expect(recovered.equals(SAMPLE_PLAINTEXT)).toBe(true);
  });

  it(
    "entropy mismatch turns the cross-decrypt RED (both directions) — the entropy plant",
    { timeout: 30_000 },
    () => {
      const entropy = Buffer.from("non-null-entropy-must-break-interop", "utf-8");

      // Direction 1: TS encrypts with NULL entropy (matches production); C#-shape decrypts
      // WITH entropy — must fail, never silently recover different bytes.
      const tsCipher = dpapiCredentialCodec.encrypt(SAMPLE_PLAINTEXT);
      expect(() => runCSharpShapeDpapi("Unprotect", tsCipher, entropy)).toThrow();

      // Direction 2: C#-shape encrypts WITH entropy; TS decrypts with its real (null-entropy)
      // codec — must fail.
      const cSharpCipherWithEntropy = runCSharpShapeDpapi("Protect", SAMPLE_PLAINTEXT, entropy);
      expect(() => dpapiCredentialCodec.decrypt(cSharpCipherWithEntropy)).toThrow();
    },
  );
});
