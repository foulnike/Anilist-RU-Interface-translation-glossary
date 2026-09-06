// Главное окно приложения грузит СВОЮ сборку (dist/app), а не чужой сайт.
//
// Прежде рядом жил запасной вид: настоящий anilist.co со внедрённым бандлом скрипта
// во втором окне (hybrid.rs, пункт 3.7). От этой реализации мы отказались целиком.
// Скрипт уехал в ветку script и остался тем, чем был всегда — юзерскриптом для
// браузера; приложение рисует свои экраны и в чужую страницу больше не заходит.
//
// Вместе с гибридным окном ушли сетевой блокировщик и сторож страницы: потребитель
// у обоих был один, и без чужого сайта им нечего делать.
//
// Метка «main» остаётся у своего окна: на неё ссылается capabilities/default.json.
// Окно создаётся здесь, а не в tauri.conf.json, чтобы способ создания был один
// и виден в одном месте.

use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// Авторизация окна у прокси. Только Windows: целиком событие WebView2.
// Потребитель теперь один — окно входа в AniList (auth.rs): оно грузит чужую
// страницу, и учётные данные прокси спрашивает у самого движка.
#[cfg(windows)]
mod proxy_auth;

// Пункт 2.2: вход в аккаунт AniList отдельным окном.
mod auth;

// Пункт 2.3: запросы к API из процесса оболочки. Без cfg: запрос из Rust
// одинаков на всех платформах, в отличие от прокси для окна.
mod anilist;

// Пункт 2.5.2: дубль снимка в файл приватного каталога. Без cfg: работа
// с файлом одинакова везде, а на Android она нужнее всего.
mod files;

// Пункт 3.3: выгрузка списка в папку, выбранную человеком. Отдельно от files.rs:
// там служебный каталог и список из трёх имён, здесь чужая папка и родное окно
// выбора. Склад снимка и выгрузка для человека — разные права.
mod export;

mod updater;

// Прокси для трафика окна. Без cfg сознательно: чтение настроек одинаково везде,
// разница в применении спрятана внутри модуля — на Linux будет внятное
// предупреждение в журнале, а не пропавшая настройка.
mod proxy;

/// Что запоминается между запусками. Не StateFlags::all(): сохранённый VISIBLE даёт
/// запуск без единого окна, а из FULLSCREEN в окне без меню нечем выйти.
/// Флаги общие и на сохранение, и на восстановление: это один параметр плагина.
fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// Перезагружает окно, из которого пришёл вызов. Окно приходит параметром, а не
/// ищется по метке: окон по-прежнему два — своё и окно входа, — и перезагружать
/// надо то, откуда просили.
#[tauri::command]
fn animori_reload(window: WebviewWindow) -> Result<(), String> {
    window.reload().map_err(|e| e.to_string())
}

/// Переключает полноэкранный режим окна и возвращает новое состояние: без него
/// его пришлось бы спрашивать вторым вызовом после каждого нажатия.
///
/// Своя команда, а не core:window:allow-set-fullscreen: разрешение из core выдаётся
/// окну целиком, то есть всему, что в этом окне исполняется; здесь право сведено
/// к одному действию.
#[tauri::command]
fn animori_toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Открывает адрес в браузере по умолчанию. В WebView2 target="_blank" и window.open()
/// превращаются в запрос нового окна, и без обработчика он отбрасывается МОЛЧА:
/// ни окна, ни ошибки, ни события на стороне JS.
///
/// Схема проверяется здесь, а не только в мосте. Прежде причина была прямая: команду
/// мог позвать чужой скрипт из окна с настоящим сайтом. Окна больше нет, а проверка
/// остаётся: команда запускает системное приложение, и такое право проверяется
/// у себя, а не на доверии к вызывающему.
#[tauri::command]
fn animori_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();

    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err(format!("Схема адреса не разрешена: {trimmed}"));
    }

    // None во втором аргументе — «браузер по умолчанию».
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Открывает системную панель трансляции экрана и больше ничего: выбор
/// приёмника делает человек, и чем он кончился, система не сообщает никому.
///
/// Своей трансляции у программы нет: отдать поток устройству умеет движок окна,
/// а WebView2 собран без приёмника вовсе. Зеркалить экран умеет сама Windows,
/// и весь наш вклад — показать её панель выбора.
///
/// Адресов два, и первый — тот самый список беспроводных экранов, который
/// Windows показывает по Win+K: схема ms-settings-connectabledevices
/// зарегистрирована как Connect UX и живёт с Windows 10. Второй запасной:
/// страница устройств в параметрах. Списка приёмников там нет, зато она есть
/// всегда — по ней хотя бы видно, куда идти дальше.
///
/// Адрес ms-actioncenter:controlcenter/CAST отсюда убран, и это правка дефекта:
/// пути CAST у той схемы нет, документирована она не была, и Windows на такой
/// адрес либо не показывает ничего, либо отвечает своим окном «нужно новое
/// приложение». Хуже всего, что запуск при этом считается УДАВШИМСЯ:
/// ShellExecute отвечает успехом на любой адрес зарегистрированной схемы,
/// и в журнал уходило «панель трансляции открыта», хотя на экране
/// не появлялось ничего. Именно так кнопка и молчала.
///
/// Отсюда и порядок попыток: сперва плагин по всем адресам подряд — его отказ
/// внятный, он означает «схему не забрало ни одно приложение», — и только
/// потом проводник по первому адресу. Проводником нельзя проверять адреса:
/// у него ответ всегда успешный, и разбирать по нему нечего.
///
/// Мимо animori_open_external намеренно: там разрешены только http и https.
/// Расширить ту проверку схемами системы значило бы отдать окну право
/// запускать любое приложение системы по любому адресу; здесь адреса зашиты
/// и параметров нет вовсе.
#[tauri::command]
fn animori_cast_panel(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        const PANELS: [&str; 2] = [
            "ms-settings-connectabledevices:devicediscovery",
            "ms-settings:connecteddevices",
        ];

        let mut reasons: Vec<String> = Vec::new();

        for uri in PANELS.iter().copied() {
            match app.opener().open_url(uri, None::<&str>) {
                Ok(()) => {
                    // Какая из двух открылась — видно только здесь, а разница
                    // в жалобах «открылось не то» решает всё.
                    log::info!("Панель трансляции открыта: {uri}");
                    return Ok(());
                }
                Err(e) => reasons.push(format!("{uri}: {e}")),
            }
        }

        let first = PANELS[0];
        let why = reasons.join("; ");

        // Последний заход. Тот же адрес по нажатию в самой Windows открывает
        // проводник, и там, где плагин отказал, панель иногда всё равно
        // появляется. Ответ проводника ни о чём не говорит: он успешен всегда,
        // и в журнал уходит предупреждение, а не «открыто».
        match std::process::Command::new("explorer.exe").arg(first).spawn() {
            Ok(_) => {
                log::warn!("Панель трансляции: плагин отказал ({why}), отдано проводнику: {first}");
                Ok(())
            }
            Err(second) => Err(format!(
                "Панель трансляции не открылась: {why}; проводник: {second}"
            )),
        }
    }

    #[cfg(not(windows))]
    {
        // Параметр не убран из подписи: команда одна на все платформы,
        // и разные подписи сломали бы generate_handler! под cfg.
        let _ = app;
        Err("Панель трансляции экрана есть только в Windows".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(anilist::AniListClientState::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        // Плагин открывает адреса в системных приложениях и нужен только со стороны Rust:
        // opener:allow-open-url, выданный окну, открыл бы что угодно любому коду в нём.
        .plugin(tauri_plugin_opener::init())
        // Память геометрии окон. Регистрация именно в цепочке Builder, а не в setup():
        // плагины оттуда поднимаются ДО setup, а окно создаётся внутри него. Плагин
        // восстановит геометрию сам; поменяешь порядок — перестанет без единой ошибки.
        // Разрешений в capabilities ему не выдано: из JS команды не вызываются.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        // Родные окна системы. Потребителей теперь два: автообновление (обоснования —
        // в updater.rs) и выбор папки для выгрузки списка (export.rs). Оба дёргаются
        // только из Rust, и разрешений разметке не выдано сознательно: updater:default
        // означал бы право чужого скрипта запустить загрузку и установку исполняемого
        // файла, а dialog:default — право открывать окна выбора файлов без нашего ведома.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Список команд дублируется в build.rs и в файлах capabilities: разрешено
        // ровно то, что перечислено в capability нужного окна. Пропуск любого из трёх мест
        // даёт отказ вида "... not allowed. Plugin not found".
        //
        // Команды из модулей указываются с путём: generate_handler! обращается к функции
        // по имени, и без префикса сборка падает с E0425.
        .invoke_handler(tauri::generate_handler![
            animori_reload,
            animori_toggle_fullscreen,
            animori_open_external,
            animori_cast_panel,
            auth::animori_auth_start,
            auth::animori_auth_submit,
            auth::animori_auth_status,
            auth::animori_auth_logout,
            anilist::animori_anilist_query,
            files::animori_file_read,
            files::animori_file_write,
            export::animori_export_pick_dir,
            export::animori_export_write,
            proxy::animori_proxy_status,
            proxy::animori_proxy_probe
        ])
        .setup(|app| {
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Info
            } else {
                log::LevelFilter::Warn
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .rotation_strategy(RotationStrategy::KeepOne)
                    .timezone_strategy(TimezoneStrategy::UseLocal)
                    .max_file_size(2_000_000)
                    .targets([Target::new(TargetKind::LogDir { file_name: None })])
                    .build(),
            )?;

            // Прокси — СТРОГО до создания первого окна: движок читает аргументы один раз,
            // на первом окне. Первым идёт своё окно, окно входа открывается позже и
            // пользуется тем же окружением. Здесь же заводится ProxyState, без которого
            // animori_proxy_status не ответит.
            proxy::apply_to_webview(app.handle());

            // Свое окно: WebviewUrl::default() — это index.html из frontendDist, то есть
            // наша сборка dist/app. Никаких скриптов инициализации здесь нет: разметка
            // своя, и стили со скриптом приходят из самого index.html.
            WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::default())
                .title("AniMori")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1024.0, 600.0)
                .resizable(true)
                .center()
                .build()?;

            // Проверка обновлений — последним шагом и только фоновой задачей: запрос
            // прямо здесь задержал бы окно на ответ GitHub, а при мёртвой сети — на весь таймаут.
            updater::spawn_check(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
