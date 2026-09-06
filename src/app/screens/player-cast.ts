// Картинка в картинке и трансляция: два умения про одно — унести кадр из окна.
// Держатся вместе, потому что оба живут на теге <video>, оба умирают вместе
// с ним и оба ничего не решают сами: экран просмотра про их устройство знать
// не должен, а этот файл не знает ничего про разметку экрана.
//
// Картинка в картинке — два пути, и первым идёт СВОЁ окно:
//   1) Document Picture-in-Picture. Движок открывает пустое окно поверх всех
//      программ, а что в нём — решаем мы: туда переезжает сам тег <video>,
//      и чужих кнопок там нет вовсе. Умение из Chromium 116, то есть есть
//      и в нашем WebView2.
//   2) Родное окно движка (requestPictureInPicture). Кадр уходит в окно,
//      которое рисует сам Edge, — вместе со своей панелью. В той панели есть
//      шестерёнка «Параметры», и ведёт она на
//      edge://settings/appearance/browserBehavior: страницу браузера, которой
//      в приложении нет и быть не может — адреса edge:// WebView2 не открывает
//      вовсе. Перехватить то нажатие нечем: окно параметров открывается мимо
//      нашего и события нового окна не поднимает — то же, что с кнопкой
//      «Настройки» в полосе загрузок (WebView2Feedback #1120). Оттого этот путь
//      стал запасным: он остаётся ради движков, где Document PiP нет.
// С hls.js работают оба: маленькое окно берёт кадры у тега, а не у ссылки,
// и про манифест не знает вовсе. Переезд тега в другой документ поток не рвёт:
// движок не перезагружает уже загруженное видео.
//
// Трансляция — два пути под одной кнопкой:
//   1) Remote Playback API. Движок сам ищет приёмники в сети и сам показывает
//      их список; поток уезжает на устройство, окно остаётся пультом. WebView2
//      собран без этого умения, но проверка дешёвая, а на других движках
//      путь честный — и там он единственный правильный: уезжает серия,
//      а не весь рабочий стол с панелью задач.
//   2) Системная панель Windows (мост, animori_cast_panel). Зеркалит экран,
//      а не кадр, зато есть там, где первого пути нет вовсе, — то есть
//      в нашей сборке. Своего приёмника у программы нет и быть не может:
//      поток отдаёт движок, а не разметка.
//
// Отказы наружу жалобой не идут. Трансляция — дело добровольное, и «приёмник
// не нашёлся» не повод гасить серию: жалоба на экране поднимает завесу
// и уводит кадр целиком. Наружу уходит лишь подпись кнопки, причина — в журнал.
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

import { JUMP_SEC, readIntent, STEP_SEC } from './player-input'

/**
 * Что показывать на кнопке: приёмников не видно и нажатие уйдёт в системную
 * панель (off), движок нашёл устройство в сети (ready), связь устанавливается
 * (linking), поток уже уехал (on).
 */
export type CastState = 'off' | 'ready' | 'linking' | 'on'

/** Чем кончилось нажатие: устройством, зеркалом экрана или ничем. */
export type CastWay = 'device' | 'screen' | 'none'

/** Обратные вызовы экрана. */
export interface CastHooks {
  /** Кадр ушёл в маленькое окно или вернулся: закрыть его могут и мимо нас. */
  onPip: (on: boolean) => void
  /** Состояние трансляции сменилось. */
  onCast: (state: CastState) => void
}

/** Что экран умеет с кадром за пределами окна. */
export interface Cast {
  /** Есть ли картинка в картинке хоть одним путём: кнопки без умения быть не должно. */
  readonly pipReady: boolean
  /** Уводит кадр в маленькое окно или возвращает назад. */
  togglePip: () => Promise<boolean>
  /** Предлагает приёмник, а где его нет — системную панель. */
  cast: () => Promise<CastWay>
  /** Снимает слежение и убирает маленькое окно за собой. */
  close: () => void
}

/**
 * Та часть Remote Playback API, которой мы пользуемся. Своё описание, а не
 * библиотечное: в описаниях DOM этого умения может не быть вовсе, а в самом
 * движке — тем более, и верить приходится полям, а не подписям.
 */
interface RemoteLink extends EventTarget {
  readonly state: string
  watchAvailability: (callback: (available: boolean) => void) => Promise<number>
  cancelWatchAvailability: (id?: number) => Promise<void>
  prompt: () => Promise<void>
}

/**
 * Та часть Document Picture-in-Picture, которой мы пользуемся. Описание своё
 * по той же причине, что и у RemoteLink: умение моложе описаний DOM и может
 * отсутствовать в движке целиком.
 */
interface DocPip {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>
}

/**
 * Убранство своего окна. Разметки здесь ни одного тега: содержимое окна —
 * сам <video>, переехавший из экрана. Свои стили нужны потому, что документ
 * у окна другой и таблица стилей приложения в него не приезжает: без них кадр
 * встал бы своим собственным размером в углу белого листа.
 */
const PIP_STYLE = [
  'html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}',
  'video{display:block;width:100%;height:100%;object-fit:contain;background:#000}',
].join('')

/** Куда вернуть тег: место в разметке экрана, а не копия тега. */
interface Spot {
  parent: Element
  next: ChildNode | null
}

/** Есть ли у тега свой список приёмников. Проверка по трём полям, которыми зовём. */
function remoteOf(video: HTMLVideoElement): RemoteLink | null {
  const box = video as unknown as { remote?: unknown }
  const remote = box.remote

  if (typeof remote !== 'object' || remote === null) return null

  const maybe = remote as Partial<RemoteLink>
  const whole =
    typeof maybe.prompt === 'function' &&
    typeof maybe.watchAvailability === 'function' &&
    typeof maybe.cancelWatchAvailability === 'function'

  return whole ? (remote as RemoteLink) : null
}

/** Умеет ли движок открывать своё окно поверх всего. */
function docPipOf(): DocPip | null {
  const box = window as unknown as { documentPictureInPicture?: unknown }
  const api = box.documentPictureInPicture

  if (typeof api !== 'object' || api === null) return null

  const maybe = api as Partial<DocPip>

  return typeof maybe.requestWindow === 'function' ? (api as DocPip) : null
}

/**
 * Умеет ли тег родное окно движка: движок разрешил и сам тег не запретил.
 * Спрашивается один раз на жизнь экрана: по ходу дела ответ не меняется.
 */
function pipAllowed(video: HTMLVideoElement): boolean {
  if (!document.pictureInPictureEnabled) return false

  return !video.disablePictureInPicture
}

/**
 * Отказ, который отказом не считается: человек закрыл список приёмников
 * (AbortError) или движок не увидел жеста (NotAllowedError). Показывать сверху
 * ещё и системную панель в ответ на закрытый список — навязчивость: человек
 * только что сказал ·«не надо».
 *
 * Спрашивается только у отказа НАСТОЯЩЕГО списка — того, который движку было
 * из чего собрать (см. cast() ниже). Без этой оговорки NotAllowedError от
 * движка, не умеющего трансляцию вовсе, читался как слово человека.
 */
function dismissed(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false

  return e.name === 'AbortError' || e.name === 'NotAllowedError'
}

/**
 * Привязывает оба умения к тегу. Один тег — одна связка на всю жизнь экрана,
 * как и у воспроизведения: слежение за приёмниками стоит сетевого опроса,
 * и заводить его заново на каждую серию незачем.
 */
export function attachCast(video: HTMLVideoElement, hooks: CastHooks): Cast {
  const remote = remoteOf(video)
  const docPip = docPipOf()
  const nativePip = pipAllowed(video)

  // Кнопка есть, пока есть хоть один путь из двух: своё окно работает и там,
  // где родное закрыто настройкой движка.
  const pipReady = docPip !== null || nativePip

  /** Видит ли движок приёмник в сети прямо сейчас. */
  let near = false

  /** Номер слежения: только для того, чтобы его снять. */
  let watch: number | null = null

  /** Своё окно, пока оно открыто. */
  let mine: Window | null = null

  /** Место, откуда уехал тег. Запоминается ровно на время переезда. */
  let spot: Spot | null = null

  /** Состояние считается в одном месте: подпись на кнопке одна. */
  function tell(): void {
    if (remote === null) {
      hooks.onCast('off')
      return
    }

    if (remote.state === 'connected') {
      hooks.onCast('on')
      return
    }

    if (remote.state === 'connecting') {
      hooks.onCast('linking')
      return
    }

    hooks.onCast(near ? 'ready' : 'off')
  }

  /**
   * Возвращает тег туда, откуда он уехал. Именно на своё место, а не в конец
   * родителя: рядом с кадром живут завеса и панель, и порядок там решает.
   */
  function bringBack(): void {
    const home = spot
    spot = null

    if (home === null) return

    if (!home.parent.isConnected) {
      // Разметка уехала целиком — обычно это уход с экрана. Возвращать тег
      // в оторванное незачем, а падать на этом — тем более.
      Logger('WARN', 'Плеер: разметка экрана уехала, кадр возвращать некуда')
      return
    }

    // Сосед мог не дожить до возврата: тогда тег встаёт последним, а не
    // падает с NotFoundError.
    const next = home.next !== null && home.next.parentNode === home.parent ? home.next : null

    home.parent.insertBefore(video, next)
  }

  /** Перемотка самим тегом: в своём окне больше спросить некого. */
  function seek(by: number): void {
    const now = video.currentTime
    const end = Number.isFinite(video.duration) ? video.duration : now + Math.abs(by)

    video.currentTime = Math.min(end, Math.max(0, now + by))
  }

  function toggle(): void {
    if (!video.paused) {
      video.pause()
      return
    }

    void video.play().catch((e: unknown) => {
      Logger('WARN', 'Плеер: серия не пошла из своего окна', e)
    })
  }

  /**
   * Клавиши внутри своего окна. Слушатель нужен свой: события чужого
   * документа в главный не всплывают, и клавиши экрана до него не дойдут.
   * Читаем тем же readIntent, что и экран: второй раскладки у одного плеера
   * быть не должно.
   *
   * Разбираем только то, что делается самим тегом: пауза, перемотка и выход.
   * Звук, скорость и выбор серии живут в экране и помнятся там же; трогать
   * их отсюда значило бы разойтись с подписью на панели приложения.
   */
  const onKey: EventListener = (event) => {
    if (!(event instanceof KeyboardEvent)) return

    // inList = false: кнопок в своём окне нет вовсе, водить фокус нечем.
    const intent = readIntent(event, false)

    switch (intent) {
      case 'toggle':
        toggle()
        break
      case 'seekBack':
        seek(-STEP_SEC)
        break
      case 'seekAhead':
        seek(STEP_SEC)
        break
      case 'jumpBack':
        seek(-JUMP_SEC)
        break
      case 'jumpAhead':
        seek(JUMP_SEC)
        break
      case 'pip':
      case 'exit':
        shut()
        break
      default:
        // Остальное нажатие остаётся ничьим: гасить то, чего мы не делаем,
        // незачем.
        return
    }

    event.preventDefault()
  }

  /** Своё окно закрылось — крестиком или нашей же кнопкой. Зовётся один раз. */
  function letGo(): void {
    const win = mine
    if (win === null) return

    mine = null
    win.removeEventListener('pagehide', onGone)
    win.document.removeEventListener('keydown', onKey)

    bringBack()
    hooks.onPip(false)
  }

  const onGone: EventListener = () => {
    letGo()
  }

  /** Закрывает своё окно сами: кадр возвращается в экран, наружу идёт слово. */
  function shut(): void {
    const win = mine
    if (win === null) return

    // Порядок важен: сперва тег домой, потом закрытие. Иначе он останется
    // в закрытом документе и серия оборвётся на полуслове.
    letGo()
    win.close()
  }

  /**
   * Открывает своё окно и перевозит в него тег. Ответ false значит «не вышло,
   * но и ничего не сломано»: кадр на месте, и можно пробовать родное окно.
   */
  async function openMine(): Promise<boolean> {
    if (docPip === null) return false

    // Размер берём с тега: окно поверх всего должно быть тем же кадром,
    // а не квадратом по умолчанию. Нули бывают у скрытого тега.
    const wide = Math.max(320, Math.round(video.clientWidth) || 480)
    const tall = Math.max(180, Math.round(video.clientHeight) || 270)

    let win: Window

    try {
      win = await docPip.requestWindow({ width: wide, height: tall })
    } catch (e) {
      // Окна может не быть вовсе: умение выключено сборкой движка или
      // жест человека не дошёл. Ничего не переезжало — остаётся родное окно.
      Logger('WARN', 'Плеер: своё окно поверх всего не открылось', e)
      return false
    }

    const parent = video.parentElement

    if (parent === null) {
      // Тег вне разметки: перевозить его значило бы потерять место возврата.
      Logger('WARN', 'Плеер: кадр вне разметки экрана, своё окно не открываем')
      win.close()
      return false
    }

    spot = { parent, next: video.nextSibling }

    const style = win.document.createElement('style')
    style.textContent = PIP_STYLE
    win.document.head.append(style)

    // Переезд, а не копия: второй тег скачал бы поток заново, а место
    // в серии, звук и скорость живут на этом.
    win.document.body.append(video)

    win.addEventListener('pagehide', onGone)
    win.document.addEventListener('keydown', onKey)

    mine = win
    hooks.onPip(true)
    return true
  }

  // События тега, а не ответ нашего же вызова: родное окно движка закрывается
  // своей крестиком и само уходит при полном экране — без подписки кнопка
  // осталась бы гореть при пустом окне. Своё окно говорит о себе само,
  // через pagehide.
  const onPipIn: EventListener = () => {
    hooks.onPip(true)
  }

  const onPipOut: EventListener = () => {
    hooks.onPip(false)
  }

  const onRemote: EventListener = () => {
    tell()
  }

  video.addEventListener('enterpictureinpicture', onPipIn)
  video.addEventListener('leavepictureinpicture', onPipOut)

  if (remote !== null) {
    remote.addEventListener('connect', onRemote)
    remote.addEventListener('connecting', onRemote)
    remote.addEventListener('disconnect', onRemote)

    // Список приёмников движок обновляет сам и молча: без слежения кнопка
    // обещала бы устройство, которого в сети уже нет.
    void remote
      .watchAvailability((available: boolean) => {
        near = available
        tell()
      })
      .then((id: number) => {
        watch = id
      })
      .catch((e: unknown) => {
        // Слежение может быть закрыто политикой движка. Кнопка остаётся
        // работать: без видимого приёмника нажатие уходит в системную
        // панель.
        Logger('WARN', 'Плеер: движок не дал следить за приёмниками', e)
      })
  }

  /**
   * Переключает маленькое окно. Возвращает состояние после нажатия, но правда
   * приезжает событием: закрыть окно можно и мимо наших кнопок.
   *
   * Порядок путей — своё окно, потом родное. В своём нет чужой панели
   * с шестерёнкой, которая уводит на страницу параметров браузера; родное же
   * остаётся запасом на движки, где своего окна не бывает.
   */
  async function togglePip(): Promise<boolean> {
    if (!pipReady) {
      Logger('WARN', 'Плеер: картинка в картинке закрыта в этом движке')
      return false
    }

    // Своё окно открыто — его же кнопкой и закрываем.
    if (mine !== null) {
      shut()
      return false
    }

    if (document.pictureInPictureElement === video) {
      try {
        await document.exitPictureInPicture()
        return false
      } catch (e) {
        Logger('WARN', 'Плеер: родное окно движка не закрылось', e)
        return document.pictureInPictureElement === video
      }
    }

    // Запрос своего окна уходит первым делом, до любого ожидания: жест
    // человека живёт ровно одну задачу, и после await его больше нет.
    if (await openMine()) return true

    if (!nativePip) return false

    try {
      await video.requestPictureInPicture()
      return true
    } catch (e) {
      // Чаще всего дело в жесте: движок требует нажатия человека, а наше
      // шло через ожидание. Кадр остаётся в окне, и жаловаться тут не на что.
      Logger('WARN', 'Плеер: картинка в картинке не открылась', e)
      return document.pictureInPictureElement === video
    }
  }

  /** Системная панель: дальше выбирает человек, и ответа мы не узнаем. */
  async function mirror(): Promise<CastWay> {
    try {
      await Bridge.shell.castPanel()
      return 'screen'
    } catch (e) {
      Logger('WARN', 'Плеер: панель трансляции не открылась', e)
      return 'none'
    }
  }

  /**
   * Нажатие на кнопку. Список движка первым: он увозит одну серию, а не весь
   * рабочий стол, и сам же гасит связь повторным 