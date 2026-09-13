import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let windows: ReturnType<typeof windowsSecurity> | undefined;

function windowsSecurity() {
  const koffi: typeof import("koffi") = require("koffi");
  const advapi = koffi.load("advapi32.dll");
  const kernel = koffi.load("kernel32.dll");
  const localFree = kernel.func("void * __stdcall LocalFree(void *value)");
  const closeHandle = kernel.func("int __stdcall CloseHandle(void *handle)");
  const getProcess = kernel.func("void * __stdcall GetCurrentProcess()");
  const openToken = advapi.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)");
  const tokenInfo = advapi.func("int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *needed)");
  const sidText = advapi.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)");
  const getSecurity = advapi.func("uint32_t __stdcall GetNamedSecurityInfoW(const char16_t *name, int kind, uint32_t info, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)");
  const getAce = advapi.func("int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)");
  const parseDescriptor = advapi.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *size)");
  const getDacl = advapi.func("int __stdcall GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)");
  const setSecurity = advapi.func("uint32_t __stdcall SetNamedSecurityInfoW(const char16_t *name, int kind, uint32_t info, void *owner, void *group, void *dacl, void *sacl)");

  const sidString = (sid: bigint): string => {
    const text = [null];
    if (!sidText(sid, text)) throw new Error("Cannot read Windows security principal");
    try { return koffi.decode(text[0], "char16_t", -1) as string; }
    finally { localFree(text[0]); }
  };
  const token = [null];
  if (!openToken(getProcess(), 8, token)) throw new Error("Cannot query Windows process identity");
  let user: string;
  try {
    const needed = [0];
    tokenInfo(token[0], 1, null, 0, needed);
    if (!needed[0] || needed[0] > 65536) throw new Error("Invalid Windows token size");
    const buffer = Buffer.alloc(needed[0]);
    if (!tokenInfo(token[0], 1, buffer, buffer.length, needed)) throw new Error("Cannot read Windows process identity");
    user = sidString(koffi.decode(buffer, "void *") as bigint);
  } finally { closeHandle(token[0]); }

  const trustedPrincipals = new Set([user, "S-1-5-18", "S-1-5-32-544"]);
  const inspect = (filePath: string, ownerOnly = false): boolean => {
    const owner = [null], dacl = [null], descriptor = [null];
    const result = getSecurity(filePath, 1, 5, owner, null, dacl, null, descriptor);
    if (result !== 0) throw new Error(`Cannot read Windows file ACL (${result})`);
    try {
      // Elevated Windows tokens can create Administrators-owned files.
      if (!owner[0] || !trustedPrincipals.has(sidString(owner[0]))) return false;
      if (ownerOnly) return true;
      if (!dacl[0]) return false;
      const count = koffi.decode(dacl[0], 4, "uint16_t") as number;
      let userAccess = false;
      for (let index = 0; index < count; index++) {
        const ace = [null];
        if (!getAce(dacl[0], index, ace) || !ace[0]) return false;
        const type = koffi.decode(ace[0], "uint8_t") as number;
        // Deny rules only restrict access. Unknown/object/callback rules fail closed.
        if (type === 1) continue;
        if (type !== 0) return false;
        const principal = sidString((ace[0] as bigint) + 8n);
        if (!trustedPrincipals.has(principal)) return false;
        const flags = koffi.decode(ace[0], 1, "uint8_t") as number;
        if (principal === user && !(flags & 8)) userAccess = true;
      }
      return userAccess;
    } finally { localFree(descriptor[0]); }
  };

  return {
    inspect,
    protect(directory: string): void {
      if (!inspect(directory, true)) throw new Error("Windows state directory must have a trusted owner");
      const descriptor = [null], dacl = [null], present = [0], defaulted = [0];
      if (!parseDescriptor(`D:P(A;OICI;FA;;;${user})`, 1, descriptor, null)) throw new Error("Cannot construct private Windows ACL");
      try {
        if (!getDacl(descriptor[0], present, dacl, defaulted) || !present[0] || !dacl[0]) throw new Error("Cannot read private Windows ACL");
        const result = setSecurity(directory, 1, 0x80000004, null, null, dacl[0], null);
        if (result !== 0) throw new Error(`Cannot protect Windows state directory (${result})`);
      } finally { localFree(descriptor[0]); }
      if (!inspect(directory)) throw new Error("Windows state directory ACL verification failed");
    },
  };
}

export const hasPrivatePermissions = (filePath: string, stat: fs.Stats, directory = false): boolean =>
  process.platform === "win32"
    ? (windows ??= windowsSecurity()).inspect(path.resolve(filePath))
    : directory ? (stat.mode & 0o077) === 0 : (stat.mode & 0o777) === 0o600;

export const protectWindowsStateDirectory = (directory: string): void => {
  if (process.platform !== "win32") return;
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error("Windows state directory must be a regular non-symlink directory");
  }
  (windows ??= windowsSecurity()).protect(resolved);
};
