const INVALID_CHAR_REGEX = /[\u0000-\u001F"#$&*+,:;<=>?[\]^`{|}\u007F]/g
const DRIVE_LETTER_REGEX = /^[a-z]:/i
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import Icons from 'unplugin-icons/vite'
import IconsResolver from 'unplugin-icons/resolver'
import UnoCSS from 'unocss/vite'
import autoprefixer from 'autoprefixer'
import { version } from './package.json';
import fs from 'fs';
import { execSync } from 'child_process';
import dayjs from 'dayjs'

function getGitCommitHash() {
  return execSync('git rev-parse --short HEAD').toString().trim();
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // 可以为不同的预加载脚本指定不同的文件
          index: resolve(__dirname, 'src/preload/index.js'),
          lyric: resolve(__dirname, 'src/preload/lyric.js')
        },
        output: {
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name].mjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
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
        resolvers: []
      }),
      Components({
        resolvers: [
          IconsResolver({
            prefix: 'i',
            enabledCollections: ['ep', 'hugeicons', 'ant-design', 'ic', 'solar', 'iconamoon']
          }),
          NaiveUiResolver()
        ]
      }),
      Icons({
        compiler: 'vue3',
        autoInstall: true
      }),
      UnoCSS(),
      {
        name: 'build-info-plugin',
        buildStart() {
          const date = dayjs().format('YYYY-MM-DD HH:mm:ss');
          const buildNumber = getGitCommitHash(); // 获取 Git 提交哈希
          const buildInfo = `export default { version: '${version}', buildNumber: '${buildNumber}', buildTime: '${date}' }`;
          console.log('Build Info:', buildInfo);
          // 将构建信息写入文件
          fs.writeFileSync(
            resolve(__dirname, 'src/renderer/src/modules/build-info.js'),
            buildInfo
          );
        },
      },
    ],
    server: {
      port: 80,
      host: '0.0.0.0'
    },
    build: {
      target: 'es2015',
      reportCompressedSize: false,
      sourcemap: false,
      commonjsOptions: {
        ignoreTryCatch: false
      },
      assetsDir: 'assets',
      chunkSizeWarningLimit: 2000, // 解决包大小超过500kb的警告
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          lyric: resolve(__dirname, 'src/renderer/desktopLyric.html')
        },
        output: {
          manualChunks: {},
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
          // 解决文件名中的非法字符
          sanitizeFileName: (name) => {
            const match = DRIVE_LETTER_REGEX.exec(name)
            const driveLetter = match ? match[0] : ''
            return driveLetter + name.slice(driveLetter.length).replace(INVALID_CHAR_REGEX, '')
          }
        },
      }
    }
  }
})
