import colorThief from 'colorthief'
import axios from 'axios'
import type { AxiosProgressEvent } from 'axios'
//pinia在request内部初始化 因为userstore和这个模块相互调用
import pinia from '@/stores/index.js'
import { useUserStore } from '@/stores/user.js'
import { MD5 } from 'crypto-js'
/*
 *-----------------------------------------------
 *以下是NeteaseCloudMusicApi接口的调用方法
 *-----------------------------------------------
 */
export let apiurl = 'https://api.xwzkj.top'
let musicApi = axios.create({
  baseURL: apiurl,
  timeout: 20000
  // withCredentials: true,
})
/**
 * 网络请求函数
 * @param {Object} params url: 请求地址,method: 请求方式,data: 请求参数
 * @returns
 */
let request = async (params, realTimeSync = true) => {
  try {
    // 浏览器环境
    const userStore = useUserStore(pinia)
    //加时间戳避免缓存
    if (realTimeSync) {
      params.params = { ...params.params, timestamp: Date.now() }
    }
    params.params = { ...params.params, realIP: userStore.ip ?? '111.37.150.114' }
    //判断如果跨域就尝试手动传递cookie
    if (localStorage.getItem('cookie') != null && apiurl.slice(0, 4) == 'http') {
      if (params.method == 'post') {
        params.data = { ...params.data, cookie: userStore.cookie }
      } else if (params.method == 'get') {
        params.params = { ...params.params, cookie: userStore.cookie }
      }
    }
    let req = await musicApi.request(params)
    return req
  } catch (e) {
    error(
      `${e.name}\n${e.message}\n${e?.response?.data?.message ?? e?.response}`,
      `API网络请求错误！可尝试使用客户端`
    )
  }
}

if (window.isElectron) {
  // console.log('当前是electron环境！')
  request = async (param, _) => {
    let { url, method, params, data } = param
    if (localStorage.getItem('cookie')) {
      data = { ...data, cookie: localStorage.getItem('cookie') }
    }
    console.log('%c本地api-发送请求', 'color: gray; background-color: lightcyan; padding: 0.5rem; border-radius: 0.5rem', param)
    let res = await window.api.netease(url, { ...data, ...params })
    console.log('%c本地api-收到响应', 'color: gray; background-color: aliceblue; padding: 0.5rem; border-radius: 0.5rem', param, res)
    return res
  }
}
export function loginStatus() {
  return request({
    url: '/login/status',
    method: 'post'
  })
}
export function userPlaylist(uid) {
  return request({
    url: '/user/playlist',
    method: 'post',
    params: { uid }
  })
}
export function likelist(uid) {
  return request({
    url: '/likelist',
    method: 'post',
    params: { uid }
  })
}
export function vipInfo() {
  return request({
    url: '/vip/info',
    method: 'post'
  })
}
export function loginQrKey() {
  return request({
    url: '/login/qr/key',
    method: 'post'
  })
}
export function loginQrCreate(key) {
  return request({
    url: '/login/qr/create',
    method: 'post',
    data: { key }
  })
}
export function loginQrCheck(key, noCookie: boolean = true) {
  return request({
    url: '/login/qr/check',
    method: 'post',
    params: { key, noCookie }
  })
}
export function songDetail(ids: string) {
  return request({
    url: '/song/detail',
    method: 'post',
    data: { ids }
  })
}
/**
 * 参数四只有在参数三有值才生效
 */
export async function songUrlV1(id: string, level: string, specialApi: string | null = null, cookie: string | null = null) {
  id = String(id)
  function apiRaw() {
    if (specialApi) {
      return axios.get(specialApi, {
        params: {
          id,
          level,
          cookie
        }
      })
    } else {
      return request({
        url: '/song/url/v1',
        method: 'post',
        data: { id, level }
      })
    }
  }
  //对结果按照参数中id的顺序排序
  let res = await apiRaw()
  // console.log(id)
  let idArray = id.split(',')
  res.data.data.sort((a, b) => {
    return idArray.indexOf(String(a.id)) - idArray.indexOf(String(b.id))
  })
  return res;
}
export function lyricNew(id) {
  return request({
    url: '/lyric/new',
    method: 'post',
    params: { id }
  })
}
export function commentNew(id: string | number, type: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 = 0, pageNo: number = 1, pageSize: number = 20, sortType: 1 | 2 | 3 = 1, cursor?: number) {
  return request({
    url: '/comment/new',
    method: 'post',
    data: { id, type, pageNo, pageSize, sortType, cursor }
  })
}

/**
 * 获取楼层评论
 * @param parentCommentId 楼层评论id
 * @param id 资源id
 * @param type 资源类型 (0: 歌曲, 1: mv, 2: 歌单, 3: 专辑, 4: 电台节目, 5: 视频, 6: 动态, 7: 电台)
 * @param limit 取出评论数量，默认20
 * @param time 分页参数，取上一页最后一项的time
 */
export function commentFloor(parentCommentId: number | string, id: number | string, type: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7, limit: number = 20, time?: number) {
  return request({
    url: '/comment/floor',
    method: 'post',
    params: { parentCommentId, id, type, limit, time }
  })
}

export function recommendSongs() {
  return request({
    url: '/recommend/songs',
    method: 'post'
  })
}
export function playlistDetail(id) {
  return request({
    url: '/playlist/detail',
    method: 'post',
    params: { id }
  })
}
export function cloudsearch(keywords: any, type: 1 | 10 | 100 | 1000 | 1002 | 1004 | 1006 | 1009 | 1014 | 1018 | 2000 = 1, offset: number = 0, limit: number = 60) {
  return request({
    url: '/cloudsearch',
    method: 'post',
    data: { keywords, type, offset, limit }
  })
}

// time的单位为秒
export function scrobble(id: string | number, time: number, sourceid: number | string = 0) {
  return request({
    url: '/scrobble',
    method: 'post',
    data: { id, time, sourceid }
  })
}
export function loginWithPhone(phone, password = null, captcha) {
  if (password != null) {
    password = MD5(password).toString()
  }
  return request({
    url: '/login/cellphone',
    method: 'post',
    data: { phone, md5_password: password, captcha }
  })
}
export function sendCaptcha(phone) {
  return request({
    url: '/captcha/sent',
    method: 'post',
    data: { phone }
  })
}
export function verifyCaptcha(phone, captcha) {
  return request({
    url: '/captcha/verify',
    method: 'post',
    data: { phone, captcha }
  })
}
export function playlistTracks(op, pid, tracks) {
  if (!op || !pid || !tracks) {
    throw new Error('[api][歌单添加或删除歌曲]参数不能为空')
  }
  return request({
    url: '/playlist/tracks',
    method: 'post',
    params: { op, pid, tracks }
  })
}
export function like(id, like = true) {
  if (id == undefined || id == null) {
    throw new Error('[api][like]id不能为空')
  }
  // return request({
  //     url: '/like',
  //     method: 'post',
  //     params: { id, like }
  // })
  const userStore = useUserStore(pinia)
  return playlistTracks(like ? 'add' : 'del', userStore.playlists?.[0]?.id, String(id))
}

export async function likeAndUpdateLikelist(id, isLike = true) {
  const userStore = useUserStore(pinia)
  //先把结果更新到列表 防止操作延迟降低使用体验
  if (isLike) {
    userStore.likedSongs.push(Number(id))
  } else {
    userStore.likedSongs.splice(userStore.likedSongs.indexOf(Number(id)), 1)
  }
  await like(id, isLike)
  userStore.updateLikelist()
}

export async function getPersonalizedPlaylist() {
  return request({
    url: '/personalized',
    method: 'post'
  })
}

/*
 *-----------------------------------------------
 *以下是colorthief包装的方法
 *-----------------------------------------------
 */
export function getColorsFromImg(imgElement, colorNum, needRaw = false) {
  let ColorThief = new colorThief()
  let rawColor = ColorThief.getPalette(imgElement, colorNum)
  // console.log('[api]获取图片多个主色raw', rawColor);
  if (needRaw) {
    return rawColor
  }
  let color = []
  for (let i = 0; i < rawColor.length; i++) {
    color[i] = `rgb(${rawColor[i][0]},${rawColor[i][1]},${rawColor[i][2]})`
  }
  // console.log('[api]获取图片多个主色result', color);
  return color
}
export function getColorFromImg(imgElement, needRaw = false) {
  let ColorThief = new colorThief()
  let rawColor = ColorThief.getColor(imgElement)
  // console.log('[api]获取图片单个主色raw', rawColor);
  if (needRaw) {
    return rawColor
  }
  let color = `rgb(${rawColor[0]},${rawColor[1]},${rawColor[2]})`
  // console.log('[api]获取图片单个主色result', color);
  return color
}
export function mixColor(colorA, colorB, weight = 0.5, needRaw = false, lighter = false) {
  let r = Math.round(colorA[0] * weight + colorB[0] * (1 - weight))
  let g = Math.round(colorA[1] * weight + colorB[1] * (1 - weight))
  let b = Math.round(colorA[2] * weight + colorB[2] * (1 - weight))
  r = Math.min(r, 255)
  g = Math.min(g, 255)
  b = Math.min(b, 255)
  r = Math.max(r, 0)
  g = Math.max(g, 0)
  b = Math.max(b, 0)
  // console.log('[debug][api]混合颜色', r, g, b);
  if (r < 155 && g < 155 && b < 155 && lighter) {
    let a = mixColor([r, g, b], [255, 255, 255], 0.45, true, true) as number[]
    r = a[0]
    g = a[1]
    b = a[2]
  }
  if (needRaw) {
    return [r, g, b]
  }
  return `rgb(${r},${g},${b})`
}

/*
 *-----------------------------------------------
 *以下是一些工具函数
 *-----------------------------------------------
 */

// 格式化次数数字，小于10000返回原数字，大于10000小于100000000返回万，大于100000000返回亿
export function formatCount(count: number | string) {
  if (typeof count !== 'number') {
    return '0';
  }

  if (count < 10000) {
    return count.toString();
  } else if (count < 100000000) {
    if (count < 100000) {
      return (count / 10000).toFixed(1).replace('.0', '') + '万';
    } else {
      return (count / 10000).toFixed(0).replace('.0', '') + '万';
    }
  } else {
    return (count / 100000000).toFixed(1).replace('.0', '') + '亿';
  }
}

export function textToParsedYrcLine(text: string) {
  return {
    line: [{ text, duration: 0, time: 0 }],
    currentWordIndex: {
      wordDuration: 0,
      wordIndex: 0
    },
    paused: false
  }
}

export function windowBack() {
  window.history.back()
}

// function renderMessage(props) {
//     let { type } = props;
//     return h(
//         NAlert,
//         {
//             closable: props.closable,
//             onClose: props.onClose,
//             type: type === "loading" ? "default" : type,
//             title: props.title,
//             style: {
//                 boxShadow: "var(--n-box-shadow)",
//                 maxWidth: "calc(100vw - 32px)",
//             }
//         },
//         {
//             default: () => props.content
//         }
//     );
// };
/**
 * @param {string} content
 * @param {string} title
 */
export function error(content: string, title?: string) {
  // let sad = ["(>_<)", "Σ(°ロ°)", '(つ﹏⊂)', '（・□・；）', '(o.O)', '(#｀皿´)', 'ヽ(≧Д≦)ノ', '（＞д＜）']
  // let title = sad[random(0, sad.length - 1)];
  console.error('[error]', content, title)
  // window.$NMessageApi.error(message, {
  //     // render: (props) => renderMessage({ ...props, title }),
  //     closable: true,
  //     duration: 10000
  // })
  window.$NNotificationApi.error({
    content,
    title,
    closable: true,
    duration: 10000,
    keepAliveOnHover: true
  })
}
export function success(content: string, title?: string) {
  // let happy = ["o(≧▽≦)o", "(* ^ ω ^)", "(´｡• ω •｡`)", "ヽ(・∀・)ﾉ", "＼(≧▽≦)／", "ヽ(o＾▽＾o)ノ", "\(^ヮ^)/", "(´• ω •`)", "(..＞◡＜..)"]
  // let title = happy[random(0, happy.length - 1)];
  // window.$NMessageApi.success(message, {
  //     // render: (props) => renderMessage({ ...props, title }),
  //     closable: false,
  //     duration: 1500
  // })
  window.$NNotificationApi.success({
    content,
    title,
    closable: true,
    duration: 1500,
    keepAliveOnHover: true
  })
}
export function msToText(ms: number) {
  let m: number | string = Math.floor(ms / 60000)
  let s: number | string = Math.floor((ms / 1000) % 60)
  if (m < 10) {
    m = '0' + m
  }
  if (s < 10) {
    s = '0' + s
  }
  return `${m}:${s}`
}
export function parseArtist(arObj) {
  let ar = arObj.map((item) => item.name)
  return ar.join('、')
}
/**
 * 把一个对象合并到目标对象 这个函数是多级递归合并
 * @param {Object} target 要合并到的对象
 * @param {Object} source 源对象
 * @returns
 */
export function objDeepMerge(target, source) {
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
        if (!target[key]) {
          target[key] = {}
        }
        objDeepMerge(target[key], source[key])
      } else {
        target[key] = source[key]
      }
    }
  }
  return target
}
/**把简单数组用'、'连起来 会判断是否为数组 不是的话会返回空文本
 * @param {Array} array
 */
export function parseArray(array) {
  if (Array.isArray(array) == true) {
    return array.join('、')
  } else {
    return ''
  }
}
/**
 * 把两个包含id属性对象数组合并 按照id对应合并
 * @param {Array} arr1
 * @param {Array} arr2
 */
export function mergeMusicObjArrs(arr1, arr2) {
  return arr1.map((item) => {
    let obj = arr2.find((item1) => item1.id == item.id)
    return obj ? { ...item, ...obj } : item
  })
}
export function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

/**
 * 防抖函数
 * @param {function} fn
 * @param {number} delay
 * @param {0|1} mode 0=每delay毫秒执行一次 1=按照delay执行最后一次
 * @returns {function}
 */
export function debounce(fn, delay, mode = 0) {
  let timer
  switch (mode) {
    case 0:
      return function (...params) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = null
            fn(...params)
          }, delay)
        }
      }

    case 1:
      return function (...params) {
        clearTimeout(timer)
        timer = setTimeout(() => {
          fn(...params)
        }, delay)
      }
  }
}

async function downloadFileLegacy(url: string, fileName: string, onProgress?: (progressEvent: AxiosProgressEvent) => void) {
  const response = await axios.get(url, { responseType: 'blob', onDownloadProgress: onProgress });
  const objurl = URL.createObjectURL(response.data);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = objurl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true
}
export async function downloadFile(url: string, fileName: string, onProgress?: (progressEvent: AxiosProgressEvent) => void, dirHandle?: FileSystemDirectoryHandle) {
  try {
    if (dirHandle) {
      // const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      const fileHandle = await dirHandle.getFileHandle(fileName, { create: true })
      const writable = await fileHandle.createWritable()
      const res = await fetch(url);
      const reader = res.body.getReader();
      const total = parseInt(res.headers.get('Content-Length'))
      let loaded = 0
      while (1) {
        // 读取数据流的第一块数据，done表示数据流是否完成，value表示当前的数
        const { done, value } = await reader.read();
        if (done) break;
        writable.write(value);

        loaded += value.length
        let e: AxiosProgressEvent = {
          loaded,
          total,
          bytes: value.length,
          lengthComputable: true
        }
        if (typeof onProgress == 'function') {
          onProgress(e)
        }
      }
      writable.close();
    } else {
      await downloadFileLegacy(url, fileName, onProgress)
    }
    return true
  }
  catch (e) {
    error(JSON.stringify(e), '文件下载失败')
    return false
  }
}

//把api返回的detail内容转换为播放列表的存储形式
export function parseDetailToList(data) {
  return data.map((item) => {
    return {
      id: item.id,
      name: item.name,
      artist: item.ar.map(item => item.name).join('、'),
      picurl: item.al.picUrl,
      tns: parseArray(item.tns),
      fee: item.fee,
    }
  });
}

export const areaData = {
  province: {
    110000: '北京市',
    120000: '天津市',
    130000: '河北省',
    140000: '山西省',
    150000: '内蒙古自治区',
    210000: '辽宁省',
    220000: '吉林省',
    230000: '黑龙江省',
    310000: '上海市',
    320000: '江苏省',
    330000: '浙江省',
    340000: '安徽省',
    350000: '福建省',
    360000: '江西省',
    370000: '山东省',
    410000: '河南省',
    420000: '湖北省',
    430000: '湖南省',
    440000: '广东省',
    450000: '广西壮族自治区',
    460000: '海南省',
    500000: '重庆市',
    510000: '四川省',
    520000: '贵州省',
    530000: '云南省',
    540000: '西藏自治区',
    610000: '陕西省',
    620000: '甘肃省',
    630000: '青海省',
    640000: '宁夏回族自治区',
    650000: '新疆维吾尔自治区'
  },
  city: {
    110101: '东城区',
    110102: '西城区',
    110105: '朝阳区',
    110106: '丰台区',
    110107: '石景山区',
    110108: '海淀区',
    110109: '门头沟区',
    110111: '房山区',
    110112: '通州区',
    110113: '顺义区',
    110114: '昌平区',
    110115: '大兴区',
    110116: '怀柔区',
    110117: '平谷区',
    110118: '密云区',
    110119: '延庆区',
    120101: '和平区',
    120102: '河东区',
    120103: '河西区',
    120104: '南开区',
    120105: '河北区',
    120106: '红桥区',
    120110: '东丽区',
    120111: '西青区',
    120112: '津南区',
    120113: '北辰区',
    120114: '武清区',
    120115: '宝坻区',
    120116: '滨海新区',
    120117: '宁河区',
    120118: '静海区',
    120119: '蓟州区',
    130100: '石家庄市',
    130200: '唐山市',
    130300: '秦皇岛市',
    130400: '邯郸市',
    130500: '邢台市',
    130600: '保定市',
    130700: '张家口市',
    130800: '承德市',
    130900: '沧州市',
    131000: '廊坊市',
    131100: '衡水市',
    140100: '太原市',
    140200: '大同市',
    140300: '阳泉市',
    140400: '长治市',
    140500: '晋城市',
    140600: '朔州市',
    140700: '晋中市',
    140800: '运城市',
    140900: '忻州市',
    141000: '临汾市',
    141100: '吕梁市',
    150100: '呼和浩特市',
    150200: '包头市',
    150300: '乌海市',
    150400: '赤峰市',
    150500: '通辽市',
    150600: '鄂尔多斯市',
    150700: '呼伦贝尔市',
    150800: '巴彦淖尔市',
    150900: '乌兰察布市',
    152200: '兴安盟',
    152500: '锡林郭勒盟',
    152900: '阿拉善盟',
    210100: '沈阳市',
    210200: '大连市',
    210300: '鞍山市',
    210400: '抚顺市',
    210500: '本溪市',
    210600: '丹东市',
    210700: '锦州市',
    210800: '营口市',
    210900: '阜新市',
    211000: '辽阳市',
    211100: '盘锦市',
    211200: '铁岭市',
    211300: '朝阳市',
    211400: '葫芦岛市',
    220100: '长春市',
    220200: '吉林市',
    220300: '四平市',
    220400: '辽源市',
    220500: '通化市',
    220600: '白山市',
    220700: '松原市',
    220800: '白城市',
    222400: '延边朝鲜族自治州',
    230100: '哈尔滨市',
    230200: '齐齐哈尔市',
    230300: '鸡西市',
    230400: '鹤岗市',
    230500: '双鸭山市',
    230600: '大庆市',
    230700: '伊春市',
    230800: '佳木斯市',
    230900: '七台河市',
    231000: '牡丹江市',
    231100: '黑河市',
    231200: '绥化市',
    232700: '大兴安岭地区',
    310101: '黄浦区',
    310104: '徐汇区',
    310105: '长宁区',
    310106: '静安区',
    310107: '普陀区',
    310109: '虹口区',
    310110: '杨浦区',
    310112: '闵行区',
    310113: '宝山区',
    310114: '嘉定区',
    310115: '浦东新区',
    310116: '金山区',
    310117: '松江区',
    310118: '青浦区',
    310120: '奉贤区',
    310151: '崇明区',
    320100: '南京市',
    320200: '无锡市',
    320300: '徐州市',
    320400: '常州市',
    320500: '苏州市',
    320600: '南通市',
    320700: '连云港市',
    320800: '淮安市',
    320900: '盐城市',
    321000: '扬州市',
    321100: '镇江市',
    321200: '泰州市',
    321300: '宿迁市',
    330100: '杭州市',
    330200: '宁波市',
    330300: '温州市',
    330400: '嘉兴市',
    330500: '湖州市',
    330600: '绍兴市',
    330700: '金华市',
    330800: '衢州市',
    330900: '舟山市',
    331000: '台州市',
    331100: '丽水市',
    340100: '合肥市',
    340200: '芜湖市',
    340300: '蚌埠市',
    340400: '淮南市',
    340500: '马鞍山市',
    340600: '淮北市',
    340700: '铜陵市',
    340800: '安庆市',
    341000: '黄山市',
    341100: '滁州市',
    341200: '阜阳市',
    341300: '宿州市',
    341500: '六安市',
    341600: '亳州市',
    341700: '池州市',
    341800: '宣城市',
    350100: '福州市',
    350200: '厦门市',
    350300: '莆田市',
    350400: '三明市',
    350500: '泉州市',
    350600: '漳州市',
    350700: '南平市',
    350800: '龙岩市',
    350900: '宁德市',
    360100: '南昌市',
    360200: '景德镇市',
    360300: '萍乡市',
    360400: '九江市',
    360500: '新余市',
    360600: '鹰潭市',
    360700: '赣州市',
    360800: '吉安市',
    360900: '宜春市',
    361000: '抚州市',
    361100: '上饶市',
    370100: '济南市',
    370200: '青岛市',
    370300: '淄博市',
    370400: '枣庄市',
    370500: '东营市',
    370600: '烟台市',
    370700: '潍坊市',
    370800: '济宁市',
    370900: '泰安市',
    371000: '威海市',
    371100: '日照市',
    371300: '临沂市',
    371400: '德州市',
    371500: '聊城市',
    371600: '滨州市',
    371700: '菏泽市',
    410100: '郑州市',
    410200: '开封市',
    410300: '洛阳市',
    410400: '平顶山市',
    410500: '安阳市',
    410600: '鹤壁市',
    410700: '新乡市',
    410800: '焦作市',
    410900: '濮阳市',
    411000: '许昌市',
    411100: '漯河市',
    411200: '三门峡市',
    411300: '南阳市',
    411400: '商丘市',
    411500: '信阳市',
    411600: '周口市',
    411700: '驻马店市',
    419001: '济源市',
    420100: '武汉市',
    420200: '黄石市',
    420300: '十堰市',
    420500: '宜昌市',
    420600: '襄阳市',
    420700: '鄂州市',
    420800: '荆门市',
    420900: '孝感市',
    421000: '荆州市',
    421100: '黄冈市',
    421200: '咸宁市',
    421300: '随州市',
    422800: '恩施土家族苗族自治州',
    429004: '仙桃市',
    429005: '潜江市',
    429006: '天门市',
    429021: '神农架林区',
    430100: '长沙市',
    430200: '株洲市',
    430300: '湘潭市',
    430400: '衡阳市',
    430500: '邵阳市',
    430600: '岳阳市',
    430700: '常德市',
    430800: '张家界市',
    430900: '益阳市',
    431000: '郴州市',
    431100: '永州市',
    431200: '怀化市',
    431300: '娄底市',
    433100: '湘西土家族苗族自治州',
    440100: '广州市',
    440200: '韶关市',
    440300: '深圳市',
    440400: '珠海市',
    440500: '汕头市',
    440600: '佛山市',
    440700: '江门市',
    440800: '湛江市',
    440900: '茂名市',
    441200: '肇庆市',
    441300: '惠州市',
    441400: '梅州市',
    441500: '汕尾市',
    441600: '河源市',
    441700: '阳江市',
    441800: '清远市',
    441900: '东莞市',
    442000: '中山市',
    445100: '潮州市',
    445200: '揭阳市',
    445300: '云浮市',
    450100: '南宁市',
    450200: '柳州市',
    450300: '桂林市',
    450400: '梧州市',
    450500: '北海市',
    450600: '防城港市',
    450700: '钦州市',
    450800: '贵港市',
    450900: '玉林市',
    451000: '百色市',
    451100: '贺州市',
    451200: '河池市',
    451300: '来宾市',
    451400: '崇左市',
    460100: '海口市',
    460200: '三亚市',
    460300: '三沙市',
    460400: '儋州市',
    469001: '五指山市',
    469002: '琼海市',
    469005: '文昌市',
    469006: '万宁市',
    469007: '东方市',
    469021: '定安县',
    469022: '屯昌县',
    469023: '澄迈县',
    469024: '临高县',
    469025: '白沙黎族自治县',
    469026: '昌江黎族自治县',
    469027: '乐东黎族自治县',
    469028: '陵水黎族自治县',
    469029: '保亭黎族苗族自治县',
    469030: '琼中黎族苗族自治县',
    500101: '万州区',
    500102: '涪陵区',
    500103: '渝中区',
    500104: '大渡口区',
    500105: '江北区',
    500106: '沙坪坝区',
    500107: '九龙坡区',
    500108: '南岸区',
    500109: '北碚区',
    500110: '綦江区',
    500111: '大足区',
    500112: '渝北区',
    500113: '巴南区',
    500114: '黔江区',
    500115: '长寿区',
    500116: '江津区',
    500117: '合川区',
    500118: '永川区',
    500119: '南川区',
    500120: '璧山区',
    500151: '铜梁区',
    500152: '潼南区',
    500153: '荣昌区',
    500154: '开州区',
    500155: '梁平区',
    500156: '武隆区',
    500229: '城口县',
    500230: '丰都县',
    500231: '垫江县',
    500233: '忠县',
    500235: '云阳县',
    500236: '奉节县',
    500237: '巫山县',
    500238: '巫溪县',
    500240: '石柱土家族自治县',
    500241: '秀山土家族苗族自治县',
    500242: '酉阳土家族苗族自治县',
    500243: '彭水苗族土家族自治县',
    510100: '成都市',
    510300: '自贡市',
    510400: '攀枝花市',
    510500: '泸州市',
    510600: '德阳市',
    510700: '绵阳市',
    510800: '广元市',
    510900: '遂宁市',
    511000: '内江市',
    511100: '乐山市',
    511300: '南充市',
    511400: '眉山市',
    511500: '宜宾市',
    511600: '广安市',
    511700: '达州市',
    511800: '雅安市',
    511900: '巴中市',
    512000: '资阳市',
    513200: '阿坝藏族羌族自治州',
    513300: '甘孜藏族自治州',
    513400: '凉山彝族自治州',
    520100: '贵阳市',
    520200: '六盘水市',
    520300: '遵义市',
    520400: '安顺市',
    520500: '毕节市',
    520600: '铜仁市',
    522300: '黔西南布依族苗族自治州',
    522600: '黔东南苗族侗族自治州',
    522700: '黔南布依族苗族自治州',
    530100: '昆明市',
    530300: '曲靖市',
    530400: '玉溪市',
    530500: '保山市',
    530600: '昭通市',
    530700: '丽江市',
    530800: '普洱市',
    530900: '临沧市',
    532300: '楚雄彝族自治州',
    532500: '红河哈尼族彝族自治州',
    532600: '文山壮族苗族自治州',
    532800: '西双版纳傣族自治州',
    532900: '大理白族自治州',
    533100: '德宏傣族景颇族自治州',
    533300: '怒江傈僳族自治州',
    533400: '迪庆藏族自治州',
    540100: '拉萨市',
    540200: '日喀则市',
    540300: '昌都市',
    540400: '林芝市',
    540500: '山南市',
    540600: '那曲市',
    542500: '阿里地区',
    610100: '西安市',
    610200: '铜川市',
    610300: '宝鸡市',
    610400: '咸阳市',
    610500: '渭南市',
    610600: '延安市',
    610700: '汉中市',
    610800: '榆林市',
    610900: '安康市',
    611000: '商洛市',
    620100: '兰州市',
    620200: '嘉峪关市',
    620300: '金昌市',
    620400: '白银市',
    620500: '天水市',
    620600: '武威市',
    620700: '张掖市',
    620800: '平凉市',
    620900: '酒泉市',
    621000: '庆阳市',
    621100: '定西市',
    621200: '陇南市',
    622900: '临夏回族自治州',
    623000: '甘南藏族自治州',
    630100: '西宁市',
    630200: '海东市',
    632200: '海北藏族自治州',
    632300: '黄南藏族自治州',
    632500: '海南藏族自治州',
    632600: '果洛藏族自治州',
    632700: '玉树藏族自治州',
    632800: '海西蒙古族藏族自治州',
    640100: '银川市',
    640200: '石嘴山市',
    640300: '吴忠市',
    640400: '固原市',
    640500: '中卫市',
    650100: '乌鲁木齐市',
    650200: '克拉玛依市',
    650400: '吐鲁番市',
    650500: '哈密市',
    652300: '昌吉回族自治州',
    652700: '博尔塔拉蒙古自治州',
    652800: '巴音郭楞蒙古自治州',
    652900: '阿克苏地区',
    653000: '克孜勒苏柯尔克孜自治州',
    653100: '喀什地区',
    653200: '和田地区',
    654000: '伊犁哈萨克自治州',
    654200: '塔城地区',
    654300: '阿勒泰地区',
    659001: '石河子市',
    659002: '阿拉尔市',
    659003: '图木舒克市',
    659004: '五家渠市',
    659005: '北屯市',
    659006: '铁门关市',
    659007: '双河市',
    659008: '可克达拉市',
    659009: '昆玉市',
    659010: '胡杨河市',
    659011: '新星市',
    659012: '白杨市'
  }
}
