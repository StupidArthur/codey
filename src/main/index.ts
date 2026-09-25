import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/contracts'
import { ProductStore } from './persistence/ProductStore'
import { CredentialVault } from './settings/CredentialVault'
import { WindowController } from './WindowController'

const controllers = new Map<number, WindowController>()
const sessionOwners = new Map<string, number>()
const pendingDisposals = new Set<Promise<void>>()
let store: ProductStore
let vault: CredentialVault
let quitReady = false

function trackDisposal(controller: WindowController): void {
  const task = controller.dispose()
  pendingDisposals.add(task)
  void task.finally(() => pendingDisposals.delete(task))
}

function controllerFor(senderId: number): WindowController {
  const controller = controllers.get(senderId)
  if (!controller) throw new Error('Window controller unavailable')
  return controller
}

function claimSession(sessionId: string, windowId: number): void {
  const owner = sessionOwners.get(sessionId)
  if (owner !== undefined && owner !== windowId) {
    const existing = BrowserWindow.fromId(owner)
    existing?.focus()
    throw new Error('此 Session 已在另一个窗口打开。')
  }
  sessionOwners.set(sessionId, windowId)
}

function releaseSession(sessionId: string, windowId: number): void {
  if (sessionOwners.get(sessionId) === windowId) sessionOwners.delete(sessionId)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1050,
    minHeight: 680,
    show: false,
    title: 'Temporal Workspace',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const webContentsId = window.webContents.id
  controllers.set(webContentsId, new WindowController(window, store, vault, claimSession, releaseSession))
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    const controller = controllers.get(webContentsId)
    controllers.delete(webContentsId)
    if (controller) trackDisposal(controller)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.chooseWorkspace, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) return null
    const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.listSessions, (event, path: string) => controllerFor(event.sender.id).listSessions(path))
  ipcMain.handle(IPC.openSession, (event, path: string, id?: string) => controllerFor(event.sender.id).openSession(path, id))
  ipcMain.handle(IPC.getSnapshot, (event) => controllerFor(event.sender.id).getSnapshot())
  ipcMain.handle(IPC.saveDraft, (event, draft, mode) => controllerFor(event.sender.id).saveDraft(draft, mode))
  ipcMain.handle(IPC.submit, (event, spec, mode) => controllerFor(event.sender.id).submit(spec, mode))
  ipcMain.handle(IPC.endRound, (event) => controllerFor(event.sender.id).endRound())
  ipcMain.handle(IPC.getModelSettings, (event) => controllerFor(event.sender.id).getModelSettings())
  ipcMain.handle(IPC.saveModelSettings, (event, settings) => controllerFor(event.sender.id).saveModelSettings(settings))
}

void app.whenReady().then(() => {
  store = new ProductStore(join(app.getPath('userData'), 'temporal-workspace.sqlite'))
  vault = new CredentialVault(join(app.getPath('userData'), 'model-credential.bin'))
  registerIpc()
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'New Window', accelerator: 'CmdOrCtrl+N', click: createWindow }, { role: 'quit' }] }
  ]))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  for (const controller of controllers.values()) trackDisposal(controller)
  controllers.clear()
  void Promise.allSettled([...pendingDisposals]).then(() => {
    store?.close()
    quitReady = true
    app.quit()
  })
})
