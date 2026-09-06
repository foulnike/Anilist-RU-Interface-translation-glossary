// Картинка в картинке и трансляция: два умения про одно — унести кадр из окна.
// Держатся вместе, потому что оба живут на теге <video>, оба умирают вместе
// с ним и оба ничего не решают сами: экран просмотра про их устройство знать
// не должен, а этот файл не знает ничего про разметку.
//
// Картинка в картинке — родное умение движка: кадр уходит в маленькое окно
// поверх всех программ, а звук, перемотка и выбор серии остаются нашими.
// С hls.js это работает без оговорок: маленькое окно берёт кадры у тега,
// а не у ссылки, и про манифест не знает вовсе.
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
  /** Есть ли картинка в картинке вовсе: кнопки без умения быть не должно. */
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

/**
 * Умеет ли тег картинку в картинке: движок разрешил и сам тег не запретил.
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
  const pipReady = pipAllowed(video)

  /** Видит ли движок приёмник в сети прямо сейчас. */
  let near = false

  /** Номер слежения: только для того, чтобы его снять. */
  let watch: number | null = null

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

  // События тега, а не ответ нашего же вызова: маленькое окно закрывается
  // своей крестиком и само уходит при полном экране — без подписки кнопка
  // осталась бы гореть при пустом окне.
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
        // Слежение может быть закрыто политикой движка. Путь остаётся:
        // список по-прежнему откроется по нажатию, просто без подсказки
        // до него.
        Logger('WARN', 'Плеер: движок не дал следить за приёмниками', e)
      })
  }

  /**
   * Переключает маленькое окно. Возвращает состояние после нажатия, но правда
   * приезжает событием: закрыть окно можно и мимо наших кнопок.
   */
  async function togglePip(): Promise<boolean> {
    if (!pipReady) {
      Logger('WARN', 'Плеер: картинка в картинке закрыта в этом движке')
      return false
    }

    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture()
        return false
      }

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
   * рабочий стол, и сам же гасит связь повторным нажатием — своей кнопки
   * «отключить» заводить не нужно.
   *
   * Список спрашивается ТОЛЬКО когда движок вправду видит приёмник в сети.
   * Прежде спрашивался всегда, стоило тегу отдать объект remote, — и в нашей
   * сборке кнопка молчала совсем. Объект этот есть в любом Chromium,
   * приёмников в WebView2 нет вовсе, и prompt() отказывал с NotAllowedError:
   * тем самым именем, которым движок называет и закрытый человеком список.
   * Отказ читался как «не надо», до системной панели дело не доходило,
   * и нажатие не делало ничего.
   *
   * Пустого выбора не бывает: нет приёмника — нет и списка, сразу зеркало.
   */
  async function cast(): Promise<CastWay> {
    if (remote !== null && near) {
      try {
        await remote.prompt()
        tell()
        return 'device'
      } catch (e) {
        if (dismissed(e)) {
          tell()
          return 'none'
        }

        // Устройство пропало из сети между слежением и нажатием (NotFoundError)
        // или умение есть лишь на бумаге: остаётся зеркало экрана. Пустое
        // нажатие было бы хуже второй панели.
        Logger('WARN', 'Плеер: список приёмников не помог', e)
      }
    }

    return await mirror()
  }

  function close(): void {
    video.removeEventListener('enterpictureinpicture', onPipIn)
    video.removeEventListener('leavepictureinpicture', onPipOut)

    if (remote !== null) {
      remote.removeEventListener('connect', onRemote)
      remote.removeEventListener('connecting', onRemote)
      remote.removeEventListener('disconnect', onRemote)

      if (watch !== null) {
        const id = watch
        watch = null

        void remote.cancelWatchAvailability(id).catch((e: unknown) => {
          Logger('WARN', 'Плеер: слежение за приёмниками не снялось', e)
        })
      }
    }

    // Маленькое окно переживает уход с экрана: без этого кадр остался бы
    // висеть поверх списка аниме и пережил бы саму серию.
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture().catch((e: unknown) => {
        Logger('WARN', 'Плеер: маленькое окно не закрылось', e)
      })
    }
  }

  // Первое слово наружу сразу: начальное состояние считается тем же местом,
  // что и все последующие, и второго знания о нём в экране не заводится.
  tell()

  return { pipReady, togglePip, cast, close }
}
