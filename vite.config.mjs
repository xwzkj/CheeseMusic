import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import Icons from 'unplugin-icons/vite'
import IconsResolver from 'unplugin-icons/resolver'
import UnoCSS from 'unocss/vite'
import autoprefixer from 'autoprefixer'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf-8'))
const serverPort = Number(process.env.CHEESE_PORT || 8090)
const serverHost = process.env.CHEESE_HOST || '127.0.0.1'

function gitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  root: resolve(rootDir, 'src/renderer'),
  publicDir: resolve(rootDir, 'src/renderer/public'),
  resolve: {
    alias: {
      '@': resolve(rootDir, 'src/renderer/src')
    },
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.json', '.vue']
  },
  css: {
    postcss: {
      plugins: [autoprefixer()]
    }
  },
  plugins: [
    vue(),
    AutoImport({
      imports: [
        'vue',
        {
          'naive-ui': ['useDialog', 'useMessage', 'useNotification', 'useLoadingBar']
        }
      ],
      dts: false
    }),
    Components({
      resolvers: [
        IconsResolver({
          prefix: 'i',
          enabledCollections: ['ep', 'hugeicons', 'ant-design', 'ic', 'solar', 'iconamoon']
        }),
        NaiveUiResolver()
      ],
      dts: false
    }),
    Icons({
      compiler: 'vue3',
      autoInstall: false
    }),
    UnoCSS(),
    {
      name: 'cheese-build-info',
      buildStart() {
        const buildInfo = `export default ${JSON.stringify({
          version: pkg.version,
          buildNumber: gitHash(),
          buildTime: new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          }).format(new Date())
        })}\n`
        writeFileSync(resolve(rootDir, 'src/renderer/src/modules/build-info.js'), buildInfo)
      }
    }
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://${serverHost}:${serverPort}`,
        changeOrigin: false
      },
      '/ws': {
        target: `ws://${serverHost}:${serverPort}`,
        ws: true
      }
    }
  },
  build: {
    outDir: resolve(rootDir, 'dist/web'),
    emptyOutDir: true,
    target: 'es2019',
    reportCompressedSize: false,
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    assetsDir: 'assets'
  }
})
