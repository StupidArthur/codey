/** Electron's Node mode is a GUI-subsystem executable. The public DSH Windows
 * ACL runner needs a console already attached before it creates restricted
 * children (otherwise they fail DLL initialization with 0xC0000142).
 * Allocate a console only in the runtime process and hide it immediately;
 * restore the inherited ACP pipe handles before loading the unchanged CLI.
 * No token, ACL, permission preset or execution policy is modified here. */
export function windowsConsolePreloadSource(koffiPath: string): string {
  return [
    "if (process.platform === 'win32' && process.versions.electron) {",
    "const koffi = require(" + JSON.stringify(koffiPath) + ");",
    "const kernel = koffi.load('kernel32.dll');",
    "const user = koffi.load('user32.dll');",
    "const getConsole = kernel.func('void * __stdcall GetConsoleWindow()');",
    "const allocConsole = kernel.func('bool __stdcall AllocConsole()');",
    "const lastError = kernel.func('uint32_t __stdcall GetLastError()');",
    "const getHandle = kernel.func('void * __stdcall GetStdHandle(uint32_t)');",
    "const setHandle = kernel.func('bool __stdcall SetStdHandle(uint32_t, void *)');",
    "const hide = user.func('bool __stdcall ShowWindow(void *, int)');",
    "if (!getConsole()) {",
    "  const ids = [0xfffffff6, 0xfffffff5, 0xfffffff4];",
    "  const handles = ids.map(id => getHandle(id));",
    "  if (!allocConsole()) throw new Error('DSH runtime console initialization failed: ' + lastError());",
    "  hide(getConsole(), 0);",
    "  ids.forEach((id, i) => { if (!setHandle(id, handles[i])) throw new Error('DSH runtime pipe restoration failed: ' + lastError()); });",
    "}",
    '}',
    ''
  ].join('\n')
}
