import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteEntry = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')
const children = []

function run(name, command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' }
  })
  child.name = name
  children.push(child)
  child.on('exit', (code, signal) => {
    if (stopping) return
    console.log(`[dev] ${name} 已退出（${signal || code}），正在关闭其他进程…`)
    stop(code ?? 1)
  })
  return child
}

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(code), 500).unref()
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

console.log('[dev] 启动服务端 http://127.0.0.1:8090 与 Vite 前端 http://127.0.0.1:5173')
run('server', process.execPath, ['--watch', 'server/index.js'])
run('vite', process.execPath, [viteEntry, '--host', '0.0.0.0'])
