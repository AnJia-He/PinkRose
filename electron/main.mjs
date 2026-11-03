import {
  app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell,
} from 'electron'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs'
import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'

const APP_NAME = 'PinkRose'
const APP_PORT = 47831
const DATA_MARKER = '.pinkrose-data.json'
const CONFIG_VERSION = 1
const DESKTOP_AUTH_HEADER = 'x-pinkrose-desktop-token'
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'media',
])

app.setName(APP_NAME)

let mainWindow = null
let backend = null
let backendOwned = false
let stoppingBackend = false
let quitting = false
let appOrigin = ''
let runtimeRoot = ''
let serverEntry = ''
let desktopToken = ''

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function runtimeBase() {
  return app.isPackaged ? process.resourcesPath : app.getAppPath()
}

function configPath() {
  return join(app.getPath('userData'), 'desktop-config.json')
}

function defaultDataDir() {
  return join(app.getPath('documents'), APP_NAME)
}

function readState() {
  const path = configPath()
  if (!existsSync(path)) return { version: CONFIG_VERSION }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('桌面版配置文件读不出来。请备份用户数据后重新安装，或联系维护者。')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('桌面版配置文件格式不对。')
  }
  return parsed
}

function writeState(state) {
  const path = configPath()
  writeFileSync(path, `${JSON.stringify({ ...state, version: CONFIG_VERSION }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
}

function storedSecretFor(state, field) {
  const current = state[field]
  if (current?.kind === 'safe' && typeof current.value === 'string') {
    try {
      const plaintext = safeStorage.decryptString(Buffer.from(current.value, 'base64'))
      if (plaintext.length >= 32) return plaintext
    } catch {
      // 系统钥匙环变化或配置来自另一台电脑时，旧登录票会失效；
      // 重新生成比把不可解密的字符串塞给服务端安全。
    }
  }
  if (current?.kind === 'plain' && typeof current.value === 'string' && current.value.length >= 32) {
    if (!safeStorage.isEncryptionAvailable()) return current.value
  }

  const secret = randomBytes(48).toString('base64url')
  if (safeStorage.isEncryptionAvailable()) {
    state[field] = {
      kind: 'safe',
      value: safeStorage.encryptString(secret).toString('base64'),
    }
  } else {
    // Linux 没有可用的 Secret Service 时仍保留 0600 权限，而不是拒绝启动。
    state[field] = { kind: 'plain', value: secret }
  }
  return secret
}

function sessionSecretFor(state) {
  return storedSecretFor(state, 'sessionSecret')
}

function desktopTokenFor(state) {
  return storedSecretFor(state, 'desktopToken')
}

function assertUsableRoot(root) {
  const target = resolve(root)
  if (target === parse(target).root || target === resolve(homedir())) {
    throw new Error('不能直接使用磁盘根目录或整个用户主目录，请选择一个专用文件夹。')
  }
  if (target === resolve(runtimeRoot)) {
    throw new Error('不能把用户数据放进程序安装目录，请选择单独的文件夹。')
  }
  return target
}

async function inspectDataRoot(root) {
  const target = assertUsableRoot(root)
  let entries = []
  try {
    entries = await readdir(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return {
    path: target,
    exists: entries.length > 0 || existsSync(target),
    empty: entries.length === 0,
    marked: entries.includes(DATA_MARKER),
    unknown: entries.filter(name => ![
      DATA_MARKER, 'pinkrose.db', 'ruixing.db', 'photos', 'luts',
    ].includes(name)),
  }
}

async function prepareDataRoot(root, { requireEmpty = false } = {}) {
  const target = assertUsableRoot(root)
  const before = await inspectDataRoot(target)
  if (requireEmpty && !before.empty && !before.marked) {
    throw new Error('目标文件夹里已有其他文件。请选择空文件夹，避免混入或覆盖现有资料。')
  }
  if (before.unknown.length > 0) {
    throw new Error('目标文件夹像是一个普通目录，不像 PinkRose 数据目录。请选择空文件夹。')
  }

  await mkdir(target, { recursive: true })
  await mkdir(join(target, 'photos'), { recursive: true })
  await mkdir(join(target, 'luts'), { recursive: true })
  if (process.platform !== 'win32') await chmod(target, 0o700)

  if (!existsSync(join(target, DATA_MARKER))) {
    await writeFile(
      join(target, DATA_MARKER),
      `${JSON.stringify({ app: APP_NAME, layout: CONFIG_VERSION }, null, 2)}\n`,
      'utf8',
    )
  }

  const probe = join(target, `.write-probe-${process.pid}`)
  await writeFile(probe, 'ok', 'utf8')
  await rm(probe, { force: true })
  return target
}

async function askForDataRoot(message) {
  const recommended = defaultDataDir()
  const answer = await dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'info',
    title: '选择 PinkRose 文件保存位置',
    message,
    detail:
      `账号、作品、原片和调色文件都会保存在你选择的专用文件夹里。\n\n`
      + `推荐位置：\n${recommended}\n\n`
      + '以后可在「个人设置 → 文件保存位置」查看或更改。',
    buttons: ['使用推荐位置', '选择其他文件夹', '退出'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (answer.response === 2) return null
  if (answer.response === 0) return recommended

  const picked = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: '选择 PinkRose 数据文件夹',
    defaultPath: recommended,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '使用这个文件夹',
  })
  return picked.canceled ? null : picked.filePaths[0] ?? null
}

async function resolveConfiguredDataRoot(state) {
  if (typeof state.dataDir === 'string' && state.dataDir.trim()) {
    try {
      await stat(state.dataDir)
      return prepareDataRoot(state.dataDir)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const answer = await dialog.showMessageBox({
        type: 'warning',
        title: '找不到 PinkRose 数据文件夹',
        message: '之前保存数据的文件夹现在不在了。',
        detail: state.dataDir,
        buttons: ['重新选择', '退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (answer.response !== 0) return null
    }
  }

  while (true) {
    const picked = await askForDataRoot('第一次使用，先把文件放在哪里？')
    if (!picked) return null
    try {
      const root = await prepareDataRoot(picked)
      state.dataDir = root
      writeState(state)
      return root
    } catch (error) {
      await dialog.showMessageBox({
        type: 'error',
        title: '这个文件夹不能用',
        message: error instanceof Error ? error.message : '请换一个文件夹再试。',
        buttons: ['重新选择'],
        noLink: true,
      })
    }
  }
}

async function probePinkRose(origin) {
  try {
    const health = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(800),
    })
    if (!health.ok) return false
    const page = await fetch(`${origin}/app`, { signal: AbortSignal.timeout(1_200) })
    return page.ok && (await page.text()).includes('PinkRose')
  } catch {
    return false
  }
}

async function startBackend(state) {
  if (backend) return
  appOrigin = `http://127.0.0.1:${APP_PORT}`
  if (await probePinkRose(appOrigin)) {
    backendOwned = false
    return
  }

  const sessionSecret = sessionSecretFor(state)
  desktopToken = desktopTokenFor(state)
  writeState(state)
  const dataRoot = state.dataDir
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '',
    PINKROSE_DESKTOP: '1',
    PINKROSE_DESKTOP_TOKEN: desktopToken,
    PORT: String(APP_PORT),
    SESSION_SECRET: sessionSecret,
    DB_PATH: join(dataRoot, 'pinkrose.db'),
    PHOTO_DIR: join(dataRoot, 'photos'),
    LUT_DIR: join(dataRoot, 'luts'),
    PINKROSE_SEARCH_MCP_PATH: join(runtimeRoot, 'build-server', 'searchMcp.cjs'),
    // 安装包不带服务端密钥，也不从使用者机器上的同名环境变量偷偷取用；
    // 用户自己的模型密钥由应用内设置写入加密数据库。
    AGNES_API_KEY: '',
    SN_API_KEY: '',
    WX_APPID: '',
    WX_SECRET: '',
  }

  backend = spawn(process.execPath, [serverEntry], {
    cwd: runtimeRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  backendOwned = true

  if (!app.isPackaged) {
    backend.stdout.on('data', chunk => process.stdout.write(`[backend] ${chunk}`))
    backend.stderr.on('data', chunk => process.stderr.write(`[backend] ${chunk}`))
  }
  backend.on('exit', (code) => {
    backend = null
    backendOwned = false
    if (!quitting && !stoppingBackend) {
      dialog.showErrorBox(
        'PinkRose 没有正常启动',
        `本地服务意外退出（代码 ${code ?? '未知'}）。请重新打开应用；如果反复出现，请查看系统是否拦截了程序。`,
      )
      app.quit()
    }
  })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await probePinkRose(appOrigin)) return
    if (!backend) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error('本地服务启动超时。请关闭后重试，或检查安全软件是否拦截了 PinkRose。')
}

async function stopBackend() {
  const child = backend
  if (!child || !backendOwned) return
  stoppingBackend = true
  await new Promise((resolveStop) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      resolveStop()
    }
    child.once('exit', finish)
    try {
      child.send({ type: 'shutdown' })
    } catch {
      child.kill('SIGTERM')
    }
    setTimeout(() => {
      if (!finished) child.kill('SIGTERM')
      finish()
    }, 5_000).unref()
  })
  backend = null
  backendOwned = false
  stoppingBackend = false
}

function trustedOrigin(url) {
  try {
    return new URL(url).origin === appOrigin
  } catch {
    return false
  }
}

async function openExternalIfSafe(url) {
  try {
    const parsed = new URL(url)
    if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
      await shell.openExternal(url)
    }
  } catch {
    // 无效链接直接忽略，交给渲染层自己提示。
  }
}

function secureWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalIfSafe(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (trustedOrigin(url)) return
    event.preventDefault()
    void openExternalIfSafe(url)
  })
  contents.on('will-attach-webview', event => event.preventDefault())
}

function secureSession(token) {
  const ses = session.fromPartition('persist:pinkrose')
  ses.webRequest.onBeforeSendHeaders(
    { urls: [`${appOrigin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          [DESKTOP_AUTH_HEADER]: token,
        },
      })
    },
  )
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || appOrigin
    callback(trustedOrigin(requestingUrl) && ALLOWED_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    trustedOrigin(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission))
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#151517',
    title: APP_NAME,
    icon: app.isPackaged
      ? join(runtimeRoot, 'app-icon-512.png')
      : join(runtimeRoot, 'public', 'app-icon-512.png'),
    webPreferences: {
      preload: join(app.getAppPath(), 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      partition: 'persist:pinkrose',
    },
  })
  secureWebContents(mainWindow.webContents)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  await mainWindow.loadURL(`${appOrigin}/app`)
}

function buildMenu(state) {
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `关于 ${APP_NAME}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${APP_NAME}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${APP_NAME}` },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开文件保存位置',
          click: () => { void shell.openPath(state.dataDir) },
        },
        {
          label: '更改文件保存位置…',
          click: () => { void changeDataDirectory() },
        },
        { type: 'separator' },
        process.platform === 'darwin'
          ? { role: 'close', label: '关闭窗口' }
          : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: '开发者工具' }]),
      ],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        {
          label: '打开 GitHub 下载页',
          click: () => { void shell.openExternal('https://github.com/AnJia-He/PinkRose/releases') },
        },
      ],
    },
  ])
}

async function changeDataDirectory() {
  if (!mainWindow) return
  const current = readState()
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: '选择新的 PinkRose 数据文件夹',
    defaultPath: current.dataDir,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择',
  })
  if (picked.canceled || !picked.filePaths[0]) return
  const target = assertUsableRoot(picked.filePaths[0])
  if (resolve(target) === resolve(current.dataDir)) return

  const inspection = await inspectDataRoot(target)
  if (inspection.unknown.length > 0) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '这个文件夹里已有其他资料',
      message: '请选择空文件夹，或原来已有的 PinkRose 数据文件夹。',
      detail: '为避免误删或混入用户文件，PinkRose 不会接管普通目录。',
      buttons: ['知道了'],
      noLink: true,
    })
    return
  }
  if (inspection.marked) {
    const useExisting = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '使用已有 PinkRose 数据',
      message: '这个文件夹已经是 PinkRose 数据目录。',
      detail: '切换后会打开这里已有的账号、作品和照片；原文件夹不会被删除。',
      buttons: ['切换并重启', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (useExisting.response !== 0) return
    await switchDataRoot(current, { target, copy: false })
    return
  }

  const decision = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: '切换文件保存位置',
    message: '新文件夹现在是空的。要把现有数据一起复制过去吗？',
    detail: '复制完成后旧文件夹仍会保留，确认新位置正常后可由你自行删除。PinkRose 不会主动删除旧数据。',
    buttons: ['复制并切换', '直接切换', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (decision.response === 2) return
  await switchDataRoot(current, { target, copy: decision.response === 0 })
}

async function switchDataRoot(current, { target, copy }) {
  if (!backendOwned) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'error',
      title: '现在不能切换',
      message: '当前本地服务不是由这个窗口启动的，无法安全迁移数据。',
      detail: '请完全退出所有 PinkRose 窗口后再重新打开。',
      buttons: ['知道了'],
      noLink: true,
    })
    return
  }

  try {
    await stopBackend()
    if (copy) {
      await cp(current.dataDir, target, {
        recursive: true,
        force: false,
        dereference: false,
      })
    }
    await prepareDataRoot(target)
    current.dataDir = target
    writeState(current)
    app.relaunch()
    app.exit(0)
  } catch (error) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'error',
      title: '没有切换成功',
      message: error instanceof Error ? error.message : '数据迁移失败。',
      detail: '原来的数据没有删除，仍在原位置。应用会继续使用原来的文件夹。',
      buttons: ['知道了'],
      noLink: true,
    })
    const state = readState()
    await startBackend(state)
    secureSession(desktopToken)
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(`${appOrigin}/app`)
  }
}

ipcMain.handle('desktop:get-storage-info', () => {
  const state = readState()
  return {
    dataDir: state.dataDir,
    platform: process.platform,
    version: app.getVersion(),
  }
})

ipcMain.handle('desktop:open-storage-folder', async () => {
  const state = readState()
  const error = await shell.openPath(state.dataDir)
  if (error) throw new Error('文件夹打不开，请从系统文件管理器里打开。')
  return { ok: true }
})

ipcMain.handle('desktop:choose-storage-folder', async () => {
  await changeDataDirectory()
  return { ok: true }
})

app.whenReady().then(async () => {
  try {
    runtimeRoot = runtimeBase()
    serverEntry = join(runtimeRoot, 'build-server', 'server.cjs')
    if (!existsSync(serverEntry)) {
      throw new Error('安装包缺少本地服务文件，请重新下载。')
    }
    const state = readState()
    const dataRoot = await resolveConfiguredDataRoot(state)
    if (!dataRoot) {
      app.quit()
      return
    }
    state.dataDir = dataRoot
    await startBackend(state)
    secureSession(desktopToken)
    Menu.setApplicationMenu(buildMenu(state))
    await createWindow()
  } catch (error) {
    dialog.showErrorBox(
      'PinkRose 打不开',
      error instanceof Error ? error.message : '启动时遇到未知问题，请重新打开。',
    )
    app.quit()
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

app.on('before-quit', (event) => {
  if (quitting || !backendOwned) return
  event.preventDefault()
  quitting = true
  void stopBackend().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
