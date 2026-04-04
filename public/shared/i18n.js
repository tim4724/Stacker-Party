'use strict';

// i18n — lightweight internationalization for Stacker Party
// Locale data is embedded to avoid async loading and flash of untranslated content.

var LOCALES = {
  en: {
    // Canvas UI labels
    hold: 'HOLD',
    next: 'NEXT',
    level: 'LEVEL',
    lines: 'LINES',
    ko: 'KO',
    go: 'GO',
    scan_to_rejoin: 'SCAN TO REJOIN',
    quad: 'QUAD!',
    triple: 'TRIPLE!',
    double: 'DOUBLE',

    // Lobby
    scan_to_join: 'Scan to join',
    square: 'SQUARE',
    hex: 'HEX',
    new_badge: 'NEW',
    waiting_for_players: 'Waiting for players...',
    start_n_players: { one: 'START ({count} player)', other: 'START ({count} players)' },
    start: 'START',

    // Buttons
    start_new_game: 'START NEW GAME',
    play_again: 'Play Again',
    play_again_upper: 'PLAY AGAIN',
    new_game: 'New Game',
    new_game_upper: 'NEW GAME',
    continue_btn: 'Continue',
    continue_upper: 'CONTINUE',
    continue_anyway: 'CONTINUE ANYWAY',
    reconnect: 'RECONNECT',
    rejoin: 'REJOIN',
    join: 'JOIN',

    // Connection
    reconnecting: 'RECONNECTING',
    disconnected: 'DISCONNECTED',
    connecting: 'CONNECTING...',
    connection_lost: 'Connection lost...',
    attempt_n_of_m: 'Attempt {attempt} of {max}',
    display_reconnecting: 'Display reconnecting...',
    bad_connection: 'Bad Connection',

    // Screens
    paused: 'PAUSED',
    open_larger_screen: 'Open on a Larger Screen',
    mobile_hint_detail: 'This display is designed for TVs and computers. Use your phone as a controller instead.',
    room_not_found: 'Room Not Found',
    scan_qr_to_join: 'Scan Game QR code to join',
    game_in_progress: 'Game in progress. Please wait for New Game.',

    // Results
    n_lines: { one: '{count} line', other: '{count} lines' },
    level_n: 'Level {level}',

    // Misc
    player: 'Player',
    level_heading: 'Level',
    enter_name: 'Enter name...',
    touchpad: 'Touchpad',
    privacy: 'Privacy',

    // Credits
    stacked_by: 'Stacked by Tim',
    music_by: 'Music by FoxSynergy',

    // Hex
    hex_lines_level: 'Lines {lines}  Level {level}',

    // Gesture hints
    swipe: 'Swipe',
    tap: 'Tap',
    flick: 'Flick',
    gesture_move: 'move',
    gesture_rotate: 'rotate',
    gesture_drop: 'drop',
    gesture_hold: 'hold',

    // Ordinals (Intl.PluralRules ordinal categories)
    _ordinal: { one: '{n}st', two: '{n}nd', few: '{n}rd', other: '{n}th' }
  },

  de: {
    hold: 'HOLD', next: 'NEXT', level: 'LEVEL', lines: 'ZEILEN',
    ko: 'K.O.', go: 'LOS', scan_to_rejoin: 'SCANNEN ZUM BEITRETEN',
    quad: 'QUAD!', triple: 'TRIPLE!', double: 'DOUBLE',
    scan_to_join: 'Zum Beitreten scannen', square: 'SQUARE', hex: 'HEX',
    new_badge: 'NEU', waiting_for_players: 'Warte auf Spieler...',
    start_n_players: { one: 'START ({count} Spieler)', other: 'START ({count} Spieler)' },
    start: 'START', start_new_game: 'NEUES SPIEL STARTEN',
    play_again: 'Nochmal spielen', play_again_upper: 'NOCHMAL SPIELEN',
    new_game: 'Neues Spiel', new_game_upper: 'NEUES SPIEL',
    continue_btn: 'Weiter', continue_upper: 'WEITER',
    continue_anyway: 'TROTZDEM FORTFAHREN',
    reconnect: 'NEU VERBINDEN', rejoin: 'BEITRETEN', join: 'BEITRETEN',
    reconnecting: 'VERBINDE NEU...', disconnected: 'GETRENNT',
    connecting: 'VERBINDE...', connection_lost: 'Verbindung verloren...',
    attempt_n_of_m: 'Versuch {attempt} von {max}',
    display_reconnecting: 'Display verbindet sich neu...',
    bad_connection: 'Schlechte Verbindung',
    paused: 'PAUSIERT', open_larger_screen: 'Auf größerem Bildschirm öffnen',
    mobile_hint_detail: 'Dieses Display ist für Fernseher und Computer. Benutze dein Smartphone als Controller.',
    room_not_found: 'Raum nicht gefunden',
    scan_qr_to_join: 'QR-Code scannen zum Beitreten',
    game_in_progress: 'Spiel läuft. Bitte auf neues Spiel warten.',
    n_lines: { one: '{count} Zeile', other: '{count} Zeilen' },
    level_n: 'Level {level}', player: 'Spieler', level_heading: 'Level',
    enter_name: 'Name eingeben...', touchpad: 'Touchpad', privacy: 'Datenschutz',
    stacked_by: 'Entwickelt von Tim', music_by: 'Musik von FoxSynergy',
    hex_lines_level: 'Zeilen {lines}  Level {level}',
    swipe: 'Wischen', tap: 'Tippen', flick: 'Schnippen',
    gesture_move: 'Bewegen', gesture_rotate: 'Drehen',
    gesture_drop: 'Ablegen', gesture_hold: 'Halten',
    _ordinal: '{n}.'
  },

  fr: {
    hold: 'HOLD', next: 'SUIVANT', level: 'NIVEAU', lines: 'LIGNES',
    ko: 'K.O.', go: 'GO', scan_to_rejoin: 'SCANNER POUR REJOINDRE',
    quad: 'QUAD !', triple: 'TRIPLE !', double: 'DOUBLE',
    scan_to_join: 'Scanner pour rejoindre', square: 'SQUARE', hex: 'HEX',
    new_badge: 'NEW', waiting_for_players: 'En attente de joueurs...',
    start_n_players: { one: 'LANCER ({count} joueur)', other: 'LANCER ({count} joueurs)' },
    start: 'LANCER', start_new_game: 'NOUVELLE PARTIE',
    play_again: 'Rejouer', play_again_upper: 'REJOUER',
    new_game: 'Nouvelle partie', new_game_upper: 'NOUVELLE PARTIE',
    continue_btn: 'Continuer', continue_upper: 'CONTINUER',
    continue_anyway: 'CONTINUER QUAND MÊME',
    reconnect: 'RECONNECTER', rejoin: 'REJOINDRE', join: 'REJOINDRE',
    reconnecting: 'RECONNEXION', disconnected: 'DÉCONNECTÉ',
    connecting: 'CONNEXION...', connection_lost: 'Connexion perdue...',
    attempt_n_of_m: 'Tentative {attempt} sur {max}',
    display_reconnecting: 'Écran en reconnexion...',
    bad_connection: 'Mauvaise connexion',
    paused: 'EN PAUSE', open_larger_screen: 'Ouvrir sur un plus grand écran',
    mobile_hint_detail: 'Cet écran est conçu pour les téléviseurs et ordinateurs. Utilisez votre téléphone comme manette.',
    room_not_found: 'Salle introuvable',
    scan_qr_to_join: 'Scanner le QR code pour rejoindre',
    game_in_progress: 'Partie en cours. Veuillez attendre une nouvelle partie.',
    n_lines: { one: '{count} ligne', other: '{count} lignes' },
    level_n: 'Niveau {level}', player: 'Joueur', level_heading: 'Niveau',
    enter_name: 'Entrez votre nom...', touchpad: 'Pavé tactile',
    privacy: 'Confidentialité',
    hex_lines_level: 'Lignes {lines}  Niveau {level}',
    swipe: 'Glisser', tap: 'Appuyer', flick: 'Lancer',
    gesture_move: 'déplacer', gesture_rotate: 'tourner',
    stacked_by: 'Créé par Tim', music_by: 'Musique par FoxSynergy',
    gesture_drop: 'lâcher', gesture_hold: 'maintenir',
    _ordinal: { one: '{n}er', other: '{n}e' }
  },

  pt: {
    hold: 'HOLD', next: 'NEXT', level: 'NÍVEL', lines: 'LINHAS',
    ko: 'K.O.', go: 'JÁ!', scan_to_rejoin: 'ESCANEIE PARA VOLTAR',
    quad: 'QUAD!', triple: 'TRIPLE!', double: 'DOUBLE',
    scan_to_join: 'Escaneie para entrar', square: 'SQUARE', hex: 'HEX',
    new_badge: 'NOVO', waiting_for_players: 'Aguardando jogadores...',
    start_n_players: { one: 'INICIAR ({count} jogador)', other: 'INICIAR ({count} jogadores)' },
    start: 'INICIAR', start_new_game: 'NOVO JOGO',
    play_again: 'Jogar novamente', play_again_upper: 'JOGAR NOVAMENTE',
    new_game: 'Novo jogo', new_game_upper: 'NOVO JOGO',
    continue_btn: 'Continuar', continue_upper: 'CONTINUAR',
    continue_anyway: 'CONTINUAR MESMO ASSIM',
    reconnect: 'RECONECTAR', rejoin: 'REENTRAR', join: 'ENTRAR',
    reconnecting: 'RECONECTANDO', disconnected: 'DESCONECTADO',
    connecting: 'CONECTANDO...', connection_lost: 'Conexão perdida...',
    attempt_n_of_m: 'Tentativa {attempt} de {max}',
    display_reconnecting: 'Tela reconectando...',
    bad_connection: 'Conexão ruim',
    paused: 'PAUSADO', open_larger_screen: 'Abra em uma tela maior',
    mobile_hint_detail: 'Este display é para TVs e computadores. Use seu celular como controle.',
    room_not_found: 'Sala não encontrada',
    scan_qr_to_join: 'Escaneie o QR code para entrar',
    game_in_progress: 'Jogo em andamento. Aguarde um novo jogo.',
    n_lines: { one: '{count} linha', other: '{count} linhas' },
    level_n: 'Nível {level}', player: 'Jogador', level_heading: 'Nível',
    enter_name: 'Digite o nome...', touchpad: 'Touchpad',
    privacy: 'Privacidade',
    stacked_by: 'Criado por Tim', music_by: 'Música por FoxSynergy',
    hex_lines_level: 'Linhas {lines}  Nível {level}',
    swipe: 'Deslizar', tap: 'Tocar', flick: 'Lançar',
    gesture_move: 'mover', gesture_rotate: 'girar',
    gesture_drop: 'soltar', gesture_hold: 'segurar',
    _ordinal: '{n}º'
  },

  es: {
    hold: 'HOLD', next: 'NEXT', level: 'NIVEL', lines: 'LÍNEAS',
    ko: 'K.O.', go: '¡YA!', scan_to_rejoin: 'ESCANEA PARA VOLVER',
    quad: '¡QUAD!', triple: '¡TRIPLE!', double: 'DOUBLE',
    scan_to_join: 'Escanea para unirte', square: 'SQUARE', hex: 'HEX',
    new_badge: 'NUEVO', waiting_for_players: 'Esperando jugadores...',
    start_n_players: { one: 'INICIAR ({count} jugador)', other: 'INICIAR ({count} jugadores)' },
    start: 'INICIAR', start_new_game: 'NUEVA PARTIDA',
    play_again: 'Jugar de nuevo', play_again_upper: 'JUGAR DE NUEVO',
    new_game: 'Nueva partida', new_game_upper: 'NUEVA PARTIDA',
    continue_btn: 'Continuar', continue_upper: 'CONTINUAR',
    continue_anyway: 'CONTINUAR DE TODAS FORMAS',
    reconnect: 'RECONECTAR', rejoin: 'VOLVER', join: 'UNIRSE',
    reconnecting: 'RECONECTANDO', disconnected: 'DESCONECTADO',
    connecting: 'CONECTANDO...', connection_lost: 'Conexión perdida...',
    attempt_n_of_m: 'Intento {attempt} de {max}',
    display_reconnecting: 'Pantalla reconectando...',
    bad_connection: 'Mala conexión',
    paused: 'PAUSA', open_larger_screen: 'Abrir en una pantalla más grande',
    mobile_hint_detail: 'Esta pantalla es para TVs y computadoras. Usa tu teléfono como control.',
    room_not_found: 'Sala no encontrada',
    scan_qr_to_join: 'Escanea el código QR para unirte',
    game_in_progress: 'Partida en curso. Espera a una nueva partida.',
    n_lines: { one: '{count} línea', other: '{count} líneas' },
    level_n: 'Nivel {level}', player: 'Jugador', level_heading: 'Nivel',
    enter_name: 'Escribe tu nombre...', touchpad: 'Touchpad',
    privacy: 'Privacidad',
    hex_lines_level: 'Líneas {lines}  Nivel {level}',
    swipe: 'Deslizar', tap: 'Tocar', flick: 'Lanzar',
    gesture_move: 'mover', gesture_rotate: 'girar',
    stacked_by: 'Creado por Tim', music_by: 'Música por FoxSynergy',
    gesture_drop: 'soltar', gesture_hold: 'guardar',
    _ordinal: '{n}º'
  },

  zh: {
    hold: '暂存', next: '下一个', level: '等级', lines: '行数',
    ko: 'K.O.', go: '开始', scan_to_rejoin: '扫码重新加入',
    quad: '四连消!', triple: '三连消!', double: '二连消',
    scan_to_join: '扫码加入', square: '方块', hex: '六角',
    new_badge: '新', waiting_for_players: '等待玩家加入...',
    start_n_players: { other: '开始 ({count} 位玩家)' },
    start: '开始', start_new_game: '开始新游戏',
    play_again: '再来一局', play_again_upper: '再来一局',
    new_game: '新游戏', new_game_upper: '新游戏',
    continue_btn: '继续', continue_upper: '继续',
    continue_anyway: '仍然继续',
    reconnect: '重新连接', rejoin: '重新加入', join: '加入',
    reconnecting: '正在重连', disconnected: '已断开连接',
    connecting: '正在连接...', connection_lost: '连接已断开...',
    attempt_n_of_m: '第 {attempt} 次尝试，共 {max} 次',
    display_reconnecting: '显示屏正在重连...',
    bad_connection: '连接不佳',
    paused: '已暂停', open_larger_screen: '请在大屏幕上打开',
    mobile_hint_detail: '此画面适用于电视和电脑。请用手机作为控制器。',
    room_not_found: '房间未找到',
    scan_qr_to_join: '扫描二维码加入游戏',
    game_in_progress: '游戏进行中，请等待新游戏开始。',
    n_lines: { other: '{count} 行' },
    level_n: '等级 {level}', player: '玩家', level_heading: '等级',
    enter_name: '输入名字...', touchpad: '触控板', privacy: '隐私',
    hex_lines_level: '行数 {lines}  等级 {level}',
    swipe: '滑动', tap: '点按', flick: '快划',
    gesture_move: '移动', gesture_rotate: '旋转',
    stacked_by: '开发者 Tim', music_by: '音乐 FoxSynergy',
    gesture_drop: '落下', gesture_hold: '暂存',
    _ordinal: '第{n}'
  },

  ja: {
    hold: 'ホールド', next: 'ネクスト', level: 'レベル', lines: 'ライン',
    ko: 'K.O.', go: 'GO', scan_to_rejoin: 'スキャンで再参加',
    quad: '4ライン!', triple: '3ライン!', double: '2ライン',
    scan_to_join: 'スキャンして参加', square: 'スクエア', hex: 'ヘックス',
    new_badge: 'NEW', waiting_for_players: 'プレイヤーを待っています...',
    start_n_players: { other: 'スタート ({count}人)' },
    start: 'スタート', start_new_game: '新しいゲームを開始',
    play_again: 'もう一度', play_again_upper: 'もう一度',
    new_game: '新しいゲーム', new_game_upper: '新しいゲーム',
    continue_btn: '続ける', continue_upper: '続ける',
    continue_anyway: 'このまま続ける',
    reconnect: '再接続', rejoin: '再参加', join: '参加',
    reconnecting: '再接続中', disconnected: '切断されました',
    connecting: '接続中...', connection_lost: '接続が切れました...',
    attempt_n_of_m: '再試行 {attempt}/{max}',
    display_reconnecting: 'ディスプレイ再接続中...',
    bad_connection: '接続不良',
    paused: '一時停止', open_larger_screen: '大きな画面で開いてください',
    mobile_hint_detail: 'この画面はテレビやパソコン用です。スマートフォンをコントローラーとして使用してください。',
    room_not_found: 'ルームが見つかりません',
    scan_qr_to_join: 'QRコードをスキャンして参加',
    game_in_progress: 'ゲーム進行中です。新しいゲームをお待ちください。',
    n_lines: { other: '{count}ライン' },
    level_n: 'レベル {level}', player: 'プレイヤー', level_heading: 'レベル',
    enter_name: '名前を入力...', touchpad: 'タッチパッド',
    privacy: 'プライバシー',
    hex_lines_level: 'ライン {lines}  レベル {level}',
    swipe: 'スワイプ', tap: 'タップ', flick: 'フリック',
    gesture_move: '移動', gesture_rotate: '回転',
    stacked_by: '開発者 Tim', music_by: '音楽 FoxSynergy',
    gesture_drop: 'ドロップ', gesture_hold: 'ホールド',
    _ordinal: '{n}位'
  },

  ko: {
    hold: '홀드', next: '다음', level: '레벨', lines: '라인',
    ko: 'K.O.', go: 'GO', scan_to_rejoin: '스캔하여 재참가',
    quad: '4줄!', triple: '3줄!', double: '2줄',
    scan_to_join: '스캔하여 참가', square: '사각', hex: '헥스',
    new_badge: 'NEW', waiting_for_players: '플레이어를 기다리는 중...',
    start_n_players: { other: '시작 ({count}명)' },
    start: '시작', start_new_game: '새 게임 시작',
    play_again: '다시 하기', play_again_upper: '다시 하기',
    new_game: '새 게임', new_game_upper: '새 게임',
    continue_btn: '계속', continue_upper: '계속',
    continue_anyway: '그래도 계속',
    reconnect: '재연결', rejoin: '재참가', join: '참가',
    reconnecting: '재연결 중', disconnected: '연결 끊김',
    connecting: '연결 중...', connection_lost: '연결이 끊어졌습니다...',
    attempt_n_of_m: '시도 {attempt}/{max}',
    display_reconnecting: '디스플레이 재연결 중...',
    bad_connection: '연결 불량',
    paused: '일시정지', open_larger_screen: '큰 화면에서 열어주세요',
    mobile_hint_detail: '이 화면은 TV와 컴퓨터용입니다. 휴대폰을 컨트롤러로 사용하세요.',
    room_not_found: '방을 찾을 수 없습니다',
    scan_qr_to_join: 'QR 코드를 스캔하여 참가',
    game_in_progress: '게임 진행 중입니다. 새 게임을 기다려주세요.',
    n_lines: { other: '{count}줄' },
    level_n: '레벨 {level}', player: '플레이어', level_heading: '레벨',
    enter_name: '이름 입력...', touchpad: '터치패드', privacy: '개인정보',
    hex_lines_level: '라인 {lines}  레벨 {level}',
    swipe: '스와이프', tap: '탭', flick: '플릭',
    gesture_move: '이동', gesture_rotate: '회전',
    stacked_by: '개발자 Tim', music_by: '음악 FoxSynergy',
    gesture_drop: '드롭', gesture_hold: '홀드',
    _ordinal: '{n}위'
  },

  ru: {
    hold: 'ХОЛД', next: 'ДАЛЕЕ', level: 'УРОВЕНЬ', lines: 'ЛИНИИ',
    ko: 'K.O.', go: 'СТАРТ', scan_to_rejoin: 'СКАН ДЛЯ ВОЗВРАТА',
    quad: 'КВАД!', triple: 'ТРИПЛ!', double: 'ДАБЛ',
    scan_to_join: 'Сканируйте для входа', square: 'КВАДРАТ', hex: 'ГЕКС',
    new_badge: 'НОВО', waiting_for_players: 'Ожидание игроков...',
    start_n_players: {
      one: 'СТАРТ ({count} игрок)', few: 'СТАРТ ({count} игрока)',
      many: 'СТАРТ ({count} игроков)', other: 'СТАРТ ({count} игроков)'
    },
    start: 'СТАРТ', start_new_game: 'НОВАЯ ИГРА',
    play_again: 'Играть снова', play_again_upper: 'ИГРАТЬ СНОВА',
    new_game: 'Новая игра', new_game_upper: 'НОВАЯ ИГРА',
    continue_btn: 'Продолжить', continue_upper: 'ПРОДОЛЖИТЬ',
    continue_anyway: 'ПРОДОЛЖИТЬ ВСЁ РАВНО',
    reconnect: 'ПЕРЕПОДКЛЮЧИТЬ', rejoin: 'ВЕРНУТЬСЯ', join: 'ВОЙТИ',
    reconnecting: 'ПЕРЕПОДКЛЮЧЕНИЕ', disconnected: 'ОТКЛЮЧЕНО',
    connecting: 'ПОДКЛЮЧЕНИЕ...', connection_lost: 'Соединение потеряно...',
    attempt_n_of_m: 'Попытка {attempt} из {max}',
    display_reconnecting: 'Дисплей переподключается...',
    bad_connection: 'Плохое соединение',
    paused: 'ПАУЗА', open_larger_screen: 'Откройте на большом экране',
    mobile_hint_detail: 'Этот экран предназначен для ТВ и компьютеров. Используйте телефон как контроллер.',
    room_not_found: 'Комната не найдена',
    scan_qr_to_join: 'Сканируйте QR-код для входа',
    game_in_progress: 'Игра идёт. Дождитесь новой игры.',
    n_lines: {
      one: '{count} линия', few: '{count} линии',
      many: '{count} линий', other: '{count} линий'
    },
    level_n: 'Уровень {level}', player: 'Игрок', level_heading: 'Уровень',
    enter_name: 'Введите имя...', touchpad: 'Тачпад',
    privacy: 'Конфиденциальность',
    hex_lines_level: 'Линии {lines}  Уровень {level}',
    swipe: 'Свайп', tap: 'Нажатие', flick: 'Смахивание',
    gesture_move: 'двигать', gesture_rotate: 'вращать',
    stacked_by: 'Разработано Tim', music_by: 'Музыка FoxSynergy',
    gesture_drop: 'бросить', gesture_hold: 'держать',
    _ordinal: '{n}-й'
  }
};

// --- Internal state ---
var _locale = 'en';
var _strings = LOCALES.en;
var _pluralRules = null;
var _ordinalRules = null;

function _initRules() {
  if (typeof Intl !== 'undefined' && Intl.PluralRules) {
    try {
      _pluralRules = new Intl.PluralRules(_locale);
      _ordinalRules = new Intl.PluralRules(_locale, { type: 'ordinal' });
    } catch (e) {
      _pluralRules = null;
      _ordinalRules = null;
    }
  }
}

/**
 * Set the active locale. Falls back to 'en' if the locale is unknown.
 * @param {string} lang - Language code (e.g. 'en', 'de', 'fr-CA')
 */
function setLocale(lang) {
  var code = (lang || 'en').toLowerCase().split('-')[0];
  if (!LOCALES[code]) code = 'en';
  _locale = code;
  _strings = LOCALES[code];
  _initRules();
}

/** @returns {string} Current locale code */
function getLocale() { return _locale; }

/**
 * Look up a translated string by key, with optional interpolation and plural selection.
 *
 * @param {string} key - Translation key
 * @param {Object} [params] - Interpolation params. If `params.count` is set and the
 *   value is an object with plural categories, the correct form is selected via Intl.PluralRules.
 * @returns {string} Translated string, or the key itself if not found
 */
function t(key, params) {
  var val = _strings[key];
  if (val === undefined) val = LOCALES.en[key];
  if (val === undefined) return key;

  // Plural selection: value is { one: '...', other: '...' } and params.count is provided
  if (typeof val === 'object') {
    var cat = (params && params.count !== undefined && _pluralRules)
      ? _pluralRules.select(params.count)
      : (params && params.count === 1 ? 'one' : 'other');
    val = val[cat] || val.other || '';
  }

  // Parameter interpolation: {paramName} → params.paramName
  if (typeof val === 'string' && params) {
    return val.replace(/\{(\w+)\}/g, function(match, k) {
      return params[k] !== undefined ? params[k] : match;
    });
  }

  return val;
}

/**
 * Format a number as an ordinal string (1st, 2nd, 3rd, ... or locale equivalent).
 * @param {number} n
 * @returns {string}
 */
function tOrdinal(n) {
  var ord = _strings._ordinal || LOCALES.en._ordinal;

  // Simple template string: '{n}.' → '1.'
  if (typeof ord === 'string') {
    return ord.replace('{n}', n);
  }

  // Object with plural categories: use Intl.PluralRules ordinal selection
  if (typeof ord === 'object' && _ordinalRules) {
    var cat = _ordinalRules.select(n);
    var tmpl = ord[cat] || ord.other || '{n}';
    return tmpl.replace('{n}', n);
  }

  return String(n);
}

/**
 * Translate all static HTML elements with data-i18n or data-i18n-placeholder attributes.
 */
function translatePage() {
  if (typeof document === 'undefined') return;

  var els = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < els.length; i++) {
    els[i].textContent = t(els[i].getAttribute('data-i18n'));
  }

  var phs = document.querySelectorAll('[data-i18n-placeholder]');
  for (var j = 0; j < phs.length; j++) {
    phs[j].placeholder = t(phs[j].getAttribute('data-i18n-placeholder'));
  }

  document.documentElement.lang = _locale;
}

/**
 * Auto-detect locale from localStorage → URL param → navigator.language → 'en'.
 */
function detectLocale() {
  var lang = null;

  // 1. localStorage preference
  if (typeof localStorage !== 'undefined') {
    try { lang = localStorage.getItem('stacker_lang'); } catch (e) { /* private browsing */ }
  }

  // 2. URL parameter ?lang=xx
  if (!lang && typeof URLSearchParams !== 'undefined' && typeof location !== 'undefined') {
    try { lang = new URLSearchParams(location.search).get('lang'); } catch (e) { /* ignore */ }
  }

  // 3. Browser language
  if (!lang && typeof navigator !== 'undefined' && navigator.language) {
    lang = navigator.language;
  }

  setLocale(lang || 'en');
}

// Auto-detect locale on load
detectLocale();

// Translate static HTML elements (scripts are at end of <body>, so DOM is ready)
translatePage();

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { t: t, tOrdinal: tOrdinal, setLocale: setLocale, getLocale: getLocale, translatePage: translatePage, detectLocale: detectLocale, LOCALES: LOCALES };
}
