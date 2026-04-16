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
    room_not_found: 'Room Not Found',
    game_ended: 'Game ended',
    game_full: 'Room is Full',
    end_step_1: 'Open <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> on a larger screen',
    end_step_2: 'Scan the QR code to use your phone as controller',
    end_how_to_play: 'How to play',
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
    imprint: 'Imprint',
    back_to_game: '← Back',

    // Privacy page
    privacy_title: 'PRIVACY NOTICE',
    privacy_controller: 'controller',
    privacy_controller_intro: 'Controller within the meaning of the GDPR is:',
    privacy_postal_address: 'Postal address:',
    privacy_see_imprint: 'see imprint',
    privacy_data: 'data',
    privacy_data_detail: 'IP addresses are processed by the web server and the WebSocket relay to serve the site and enable multiplayer communication. They appear in server access logs, which are retained for a maximum of 7 days for security purposes (abuse detection and operational troubleshooting) and then automatically deleted. Logs are not shared with third parties. Processing is based on legitimate interest in operating the service (Art. 6(1)(f) GDPR).',
    privacy_tracking: 'tracking',
    privacy_tracking_detail: 'No cookies, no analytics, no third-party services, and no tracking-related local storage are used.',
    privacy_gameplay: 'gameplay',
    privacy_gameplay_detail: 'Player names and inputs are relayed between players during a session and exist only in memory. Nothing is stored. Processing is based on legitimate interest in operating the service (Art. 6(1)(f) GDPR).',
    privacy_hosting: 'hosting',
    privacy_hosting_detail: 'Processing takes place exclusively on servers operated by the controller within Germany. No processors within the meaning of Art. 28 GDPR are engaged. No personal data is transferred to third countries.',
    privacy_rights: 'your rights',
    privacy_rights_detail: 'You have the right to access (Art. 15 GDPR), rectification (Art. 16), erasure (Art. 17), and restriction of processing (Art. 18). To exercise these rights, contact the controller using the e-mail address above. Your separate right to object under Art. 21 GDPR is set out below.',
    privacy_authority: 'supervisory authority',
    privacy_authority_detail: 'You have the right to lodge a complaint with a data protection supervisory authority (Art. 77 GDPR). The competent authority is: Bayerisches Landesamt für Datenschutzaufsicht (BayLDA), Promenade 18, 91522 Ansbach.',
    privacy_automated: 'automated decisions',
    privacy_automated_detail: 'No automated decision-making within the meaning of Art. 22 GDPR takes place.',
    privacy_objection: 'Right to object (Art. 21 GDPR)',
    privacy_objection_detail: 'You have the right at any time, on grounds relating to your particular situation, to object to the processing of personal data concerning you which is based on legitimate interest (Art. 6(1)(f) GDPR) — Art. 21(1) GDPR. An informal e-mail to the address stated in the imprint is sufficient to exercise this right.',
    privacy_updated: 'Last updated April 2026',

    // Imprint page
    imprint_title: 'IMPRINT',
    imprint_notice: 'Information pursuant to § 5 DDG',
    imprint_contact: 'contact',
    imprint_page_title: 'Imprint — Stacker Party',
    privacy_page_title: 'Privacy — Stacker Party',

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
    scan_to_join: 'Scannen zum Beitreten', square: 'SQUARE', hex: 'HEX',
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
    paused: 'PAUSIERT', room_not_found: 'Raum nicht gefunden', game_full: 'Raum ist voll',
    game_ended: 'Spiel beendet',
    end_step_1: 'Öffne <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> auf einem größeren Bildschirm',
    end_step_2: 'Scanne den QR-Code, um dein Handy als Controller zu nutzen',
    end_how_to_play: 'So wird gespielt',
    game_in_progress: 'Spiel läuft. Bitte auf neues Spiel warten.',
    n_lines: { one: '{count} Zeile', other: '{count} Zeilen' },
    level_n: 'Level {level}', player: 'Spieler', level_heading: 'Level',
    enter_name: 'Name eingeben...', touchpad: 'Touchpad', privacy: 'Datenschutz',
    imprint: 'Impressum',
    imprint_title: 'IMPRESSUM',
    imprint_notice: 'Angaben gemäß § 5 DDG',
    imprint_contact: 'Kontakt',
    imprint_page_title: 'Impressum — Stacker Party',
    privacy_page_title: 'Datenschutz — Stacker Party',
    back_to_game: '← Zurück',
    privacy_title: 'DATENSCHUTZ\u00ADERKLÄRUNG',
    privacy_controller: 'Verantwortlicher',
    privacy_controller_intro: 'Verantwortlicher im Sinne der DSGVO ist:',
    privacy_postal_address: 'Postanschrift:',
    privacy_see_imprint: 'siehe Impressum',
    privacy_data: 'Daten',
    privacy_data_detail: 'IP-Adressen werden vom Webserver und dem WebSocket-Relay zur Bereitstellung der Seite und zur Ermöglichung der Multiplayer-Kommunikation verarbeitet. Sie erscheinen in Zugriffslogs, die zu Sicherheitszwecken (Missbrauchserkennung und Betriebsanalyse) für maximal 7 Tage gespeichert und anschließend automatisch gelöscht werden. Die Logs werden nicht an Dritte weitergegeben. Die Verarbeitung erfolgt auf Grundlage des berechtigten Interesses am Betrieb des Dienstes (Art. 6 Abs. 1 lit. f DSGVO).',
    privacy_tracking: 'Tracking',
    privacy_tracking_detail: 'Es werden keine Cookies, keine Analysedienste, keine Drittanbieterdienste und kein Tracking-bezogener Local Storage eingesetzt.',
    privacy_gameplay: 'Spielbetrieb',
    privacy_gameplay_detail: 'Spielernamen und Eingaben werden während einer Sitzung zwischen den Spielern übertragen und existieren ausschließlich im Arbeitsspeicher. Es wird nichts gespeichert. Die Verarbeitung erfolgt auf Grundlage des berechtigten Interesses am Betrieb des Dienstes (Art. 6 Abs. 1 lit. f DSGVO).',
    privacy_hosting: 'Hosting',
    privacy_hosting_detail: 'Die Verarbeitung erfolgt ausschließlich auf Servern des Verantwortlichen innerhalb Deutschlands. Es werden keine Auftragsverarbeiter im Sinne des Art. 28 DSGVO eingesetzt. Eine Übermittlung personenbezogener Daten in Drittländer findet nicht statt.',
    privacy_rights: 'Rechte der Betroffenen',
    privacy_rights_detail: 'Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17) sowie Einschränkung der Verarbeitung (Art. 18). Zur Ausübung dieser Rechte wenden Sie sich bitte an den Verantwortlichen unter der oben angegebenen E-Mail-Adresse. Ihr gesondertes Widerspruchsrecht nach Art. 21 DSGVO finden Sie weiter unten.',
    privacy_authority: 'Aufsichtsbehörde',
    privacy_authority_detail: 'Sie haben das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren (Art. 77 DSGVO). Zuständig ist: Bayerisches Landesamt für Datenschutzaufsicht (BayLDA), Promenade 18, 91522 Ansbach.',
    privacy_automated: 'Automatisierte Entscheidungsfindung',
    privacy_automated_detail: 'Eine automatisierte Entscheidungsfindung im Sinne des Art. 22 DSGVO findet nicht statt.',
    privacy_objection: 'Widerspruchsrecht (Art. 21 DSGVO)',
    privacy_objection_detail: 'Sie haben das Recht, aus Gründen, die sich aus Ihrer besonderen Situation ergeben, jederzeit gegen die Verarbeitung Sie betreffender personenbezogener Daten, die auf Grundlage des berechtigten Interesses (Art. 6 Abs. 1 lit. f DSGVO) erfolgt, Widerspruch einzulegen (Art. 21 Abs. 1 DSGVO). Zur Ausübung Ihres Widerspruchsrechts genügt eine formlose E-Mail an die im Impressum angegebene Adresse.',
    privacy_updated: 'Zuletzt aktualisiert April 2026',
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
    paused: 'EN PAUSE', room_not_found: 'Salle introuvable', game_full: 'Salle pleine',
    game_ended: 'Partie terminée',
    end_step_1: 'Ouvre <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> sur un plus grand écran',
    end_step_2: 'Scanne le QR code pour utiliser ton téléphone comme manette',
    end_how_to_play: 'Comment jouer',
    game_in_progress: 'Partie en cours. Veuillez attendre une nouvelle partie.',
    n_lines: { one: '{count} ligne', other: '{count} lignes' },
    level_n: 'Niveau {level}', player: 'Joueur', level_heading: 'Niveau',
    enter_name: 'Entrez votre nom...', touchpad: 'Pavé tactile',
    privacy: 'Confidentialité', imprint: 'Mentions légales', back_to_game: '← Retour',
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
    paused: 'PAUSADO', room_not_found: 'Sala não encontrada', game_full: 'Sala cheia',
    game_ended: 'Jogo encerrado',
    end_step_1: 'Abra <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> em uma tela maior',
    end_step_2: 'Escaneie o QR code para usar seu celular como controle',
    end_how_to_play: 'Como jogar',
    game_in_progress: 'Jogo em andamento. Aguarde um novo jogo.',
    n_lines: { one: '{count} linha', other: '{count} linhas' },
    level_n: 'Nível {level}', player: 'Jogador', level_heading: 'Nível',
    enter_name: 'Digite o nome...', touchpad: 'Touchpad',
    privacy: 'Privacidade', imprint: 'Aviso legal', back_to_game: '← Voltar',
    stacked_by: 'Criado por Tim', music_by: 'Música de FoxSynergy',
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
    paused: 'PAUSA', room_not_found: 'Sala no encontrada', game_full: 'Sala llena',
    game_ended: 'Partida finalizada',
    end_step_1: 'Abre <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> en una pantalla más grande',
    end_step_2: 'Escanea el código QR para usar tu teléfono como control',
    end_how_to_play: 'Cómo jugar',
    game_in_progress: 'Partida en curso. Espera a una nueva partida.',
    n_lines: { one: '{count} línea', other: '{count} líneas' },
    level_n: 'Nivel {level}', player: 'Jugador', level_heading: 'Nivel',
    enter_name: 'Escribe tu nombre...', touchpad: 'Touchpad',
    privacy: 'Privacidad', imprint: 'Aviso legal', back_to_game: '← Volver',
    hex_lines_level: 'Líneas {lines}  Nivel {level}',
    swipe: 'Deslizar', tap: 'Tocar', flick: 'Lanzar',
    gesture_move: 'mover', gesture_rotate: 'girar',
    stacked_by: 'Creado por Tim', music_by: 'Música de FoxSynergy',
    gesture_drop: 'soltar', gesture_hold: 'mantener',
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
    paused: '已暂停', room_not_found: '房间未找到', game_full: '房间已满',
    game_ended: '游戏已结束',
    end_step_1: '在更大的屏幕上打开 <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a>',
    end_step_2: '扫描二维码，将手机用作控制器',
    end_how_to_play: '游戏方法',
    game_in_progress: '游戏进行中，请等待新游戏开始。',
    n_lines: { other: '{count} 行' },
    level_n: '等级 {level}', player: '玩家', level_heading: '等级',
    enter_name: '输入名字...', touchpad: '触控板', privacy: '隐私', imprint: '法律声明', back_to_game: '← 返回',
    hex_lines_level: '行数 {lines}  等级 {level}',
    swipe: '滑动', tap: '点按', flick: '快划',
    gesture_move: '移动', gesture_rotate: '旋转',
    stacked_by: '开发：Tim', music_by: '音乐：FoxSynergy',
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
    paused: '一時停止', room_not_found: 'ルームが見つかりません', game_full: 'ルームが満員です',
    game_ended: 'ゲーム終了',
    end_step_1: 'より大きな画面で <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> を開く',
    end_step_2: 'QRコードをスキャンして、スマートフォンをコントローラーとして使用',
    end_how_to_play: '遊び方',
    game_in_progress: 'ゲーム進行中です。新しいゲームをお待ちください。',
    n_lines: { other: '{count}ライン' },
    level_n: 'レベル {level}', player: 'プレイヤー', level_heading: 'レベル',
    enter_name: '名前を入力...', touchpad: 'タッチパッド',
    privacy: 'プライバシー', imprint: '運営者情報', back_to_game: '← 戻る',
    hex_lines_level: 'ライン {lines}  レベル {level}',
    swipe: 'スワイプ', tap: 'タップ', flick: 'フリック',
    gesture_move: '移動', gesture_rotate: '回転',
    stacked_by: '開発：Tim', music_by: '音楽：FoxSynergy',
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
    paused: '일시정지', room_not_found: '방을 찾을 수 없습니다', game_full: '방이 가득 찼습니다',
    game_ended: '게임 종료',
    end_step_1: '더 큰 화면에서 <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> 열기',
    end_step_2: 'QR 코드를 스캔하여 휴대폰을 컨트롤러로 사용하세요',
    end_how_to_play: '플레이 방법',
    game_in_progress: '게임 진행 중입니다. 새 게임을 기다려주세요.',
    n_lines: { other: '{count}줄' },
    level_n: '레벨 {level}', player: '플레이어', level_heading: '레벨',
    enter_name: '이름 입력...', touchpad: '터치패드', privacy: '개인정보', imprint: '법적 고지', back_to_game: '← 돌아가기',
    hex_lines_level: '라인 {lines}  레벨 {level}',
    swipe: '스와이프', tap: '탭', flick: '플릭',
    gesture_move: '이동', gesture_rotate: '회전',
    stacked_by: '개발: Tim', music_by: '음악: FoxSynergy',
    gesture_drop: '드롭', gesture_hold: '홀드',
    _ordinal: '{n}위'
  },

  ru: {
    hold: 'ХОЛД', next: 'ДАЛЕЕ', level: 'УРОВЕНЬ', lines: 'ЛИНИИ',
    ko: 'K.O.', go: 'СТАРТ', scan_to_rejoin: 'СКАНИРУЙТЕ ДЛЯ ВХОДА',
    quad: 'КВАД!', triple: 'ТРИПЛ!', double: 'ДАБЛ',
    scan_to_join: 'Сканируйте для входа', square: 'КВАДРАТ', hex: 'ГЕКС',
    new_badge: 'НОВОЕ', waiting_for_players: 'Ожидание игроков...',
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
    paused: 'ПАУЗА', room_not_found: 'Комната не найдена', game_full: 'Комната заполнена',
    game_ended: 'Игра завершена',
    end_step_1: 'Откройте <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> на большом экране',
    end_step_2: 'Отсканируйте QR-код, чтобы использовать телефон как контроллер',
    end_how_to_play: 'Как играть',
    game_in_progress: 'Игра идёт. Дождитесь новой игры.',
    n_lines: {
      one: '{count} линия', few: '{count} линии',
      many: '{count} линий', other: '{count} линий'
    },
    level_n: 'Уровень {level}', player: 'Игрок', level_heading: 'Уровень',
    enter_name: 'Введите имя...', touchpad: 'Тачпад',
    privacy: 'Конфиденциальность', imprint: 'Выходные данные', back_to_game: '← Назад',
    hex_lines_level: 'Линии {lines}  Уровень {level}',
    swipe: 'Свайп', tap: 'Нажатие', flick: 'Смахивание',
    gesture_move: 'двигать', gesture_rotate: 'вращать',
    stacked_by: 'Разработка: Tim', music_by: 'Музыка: FoxSynergy',
    gesture_drop: 'бросить', gesture_hold: 'держать',
    _ordinal: '{n}-й'
  },

  it: {
    hold: 'HOLD', next: 'NEXT', level: 'LIVELLO', lines: 'LINEE',
    ko: 'K.O.', go: 'VIA!', scan_to_rejoin: 'SCANSIONA PER RIENTRARE',
    quad: 'QUAD!', triple: 'TRIPLE!', double: 'DOUBLE',
    scan_to_join: 'Scansiona per unirti', square: 'SQUARE', hex: 'HEX',
    new_badge: 'NUOVO', waiting_for_players: 'In attesa di giocatori...',
    start_n_players: { one: 'AVVIA ({count} giocatore)', other: 'AVVIA ({count} giocatori)' },
    start: 'AVVIA', start_new_game: 'NUOVA PARTITA',
    play_again: 'Gioca ancora', play_again_upper: 'GIOCA ANCORA',
    new_game: 'Nuova partita', new_game_upper: 'NUOVA PARTITA',
    continue_btn: 'Continua', continue_upper: 'CONTINUA',
    continue_anyway: 'CONTINUA COMUNQUE',
    reconnect: 'RICONNETTI', rejoin: 'RIENTRA', join: 'UNISCITI',
    reconnecting: 'RICONNESSIONE', disconnected: 'DISCONNESSO',
    connecting: 'CONNESSIONE...', connection_lost: 'Connessione persa...',
    attempt_n_of_m: 'Tentativo {attempt} di {max}',
    display_reconnecting: 'Display in riconnessione...',
    bad_connection: 'Connessione scarsa',
    paused: 'IN PAUSA', room_not_found: 'Stanza non trovata', game_full: 'Stanza piena',
    game_ended: 'Partita terminata',
    end_step_1: 'Apri <a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> su uno schermo più grande',
    end_step_2: 'Scansiona il QR code per usare il telefono come controller',
    end_how_to_play: 'Come giocare',
    game_in_progress: 'Partita in corso. Attendi una nuova partita.',
    n_lines: { one: '{count} linea', other: '{count} linee' },
    level_n: 'Livello {level}', player: 'Giocatore', level_heading: 'Livello',
    enter_name: 'Inserisci nome...', touchpad: 'Touchpad',
    privacy: 'Privacy', imprint: 'Note legali', back_to_game: '← Indietro',
    stacked_by: 'Creato da Tim', music_by: 'Musica di FoxSynergy',
    hex_lines_level: 'Linee {lines}  Livello {level}',
    swipe: 'Scorrere', tap: 'Toccare', flick: 'Lanciare',
    gesture_move: 'muovere', gesture_rotate: 'ruotare',
    gesture_drop: 'rilasciare', gesture_hold: 'tenere',
    _ordinal: '{n}°'
  },

  tr: {
    hold: 'HOLD', next: 'NEXT', level: 'SEVİYE', lines: 'SATIR',
    ko: 'K.O.', go: 'BAŞLA!', scan_to_rejoin: 'KATILMAK İÇİN TARA',
    quad: 'DÖRTLÜ!', triple: 'ÜÇLÜ!', double: 'İKİLİ',
    scan_to_join: 'Katılmak için tara', square: 'SQUARE', hex: 'HEX',
    new_badge: 'YENİ', waiting_for_players: 'Oyuncular bekleniyor...',
    start_n_players: { one: 'BAŞLAT ({count} oyuncu)', other: 'BAŞLAT ({count} oyuncu)' },
    start: 'BAŞLAT', start_new_game: 'YENİ OYUN BAŞLAT',
    play_again: 'Tekrar oyna', play_again_upper: 'TEKRAR OYNA',
    new_game: 'Yeni oyun', new_game_upper: 'YENİ OYUN',
    continue_btn: 'Devam', continue_upper: 'DEVAM',
    continue_anyway: 'YİNE DE DEVAM ET',
    reconnect: 'YENİDEN BAĞLAN', rejoin: 'KATIL', join: 'KATIL',
    reconnecting: 'YENİDEN BAĞLANIYOR', disconnected: 'BAĞLANTI KESİLDİ',
    connecting: 'BAĞLANIYOR...', connection_lost: 'Bağlantı kesildi...',
    attempt_n_of_m: 'Deneme {attempt}/{max}',
    display_reconnecting: 'Ekran yeniden bağlanıyor...',
    bad_connection: 'Kötü bağlantı',
    paused: 'DURAKLATILDI', room_not_found: 'Oda bulunamadı', game_full: 'Oda dolu',
    game_ended: 'Oyun sona erdi',
    end_step_1: '<a href="https://couch-games.com" id="end-step-1-link" class="end-link">couch-games.com</a> adresini daha büyük bir ekranda aç',
    end_step_2: 'Telefonunu kumanda olarak kullanmak için QR kodu tara',
    end_how_to_play: 'Nasıl oynanır',
    game_in_progress: 'Oyun devam ediyor. Yeni oyunu bekle.',
    n_lines: { one: '{count} satır', other: '{count} satır' },
    level_n: 'Seviye {level}', player: 'Oyuncu', level_heading: 'Seviye',
    enter_name: 'İsim gir...', touchpad: 'Touchpad',
    privacy: 'Gizlilik', imprint: 'Künye', back_to_game: '← Geri',
    stacked_by: 'Yapımcı: Tim', music_by: 'Müzik: FoxSynergy',
    hex_lines_level: 'Satır {lines}  Seviye {level}',
    swipe: 'Kaydır', tap: 'Dokun', flick: 'Fırlat',
    gesture_move: 'hareket', gesture_rotate: 'döndür',
    gesture_drop: 'bırak', gesture_hold: 'tut',
    _ordinal: '{n}.'
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
 * Translate all static HTML elements with data-i18n, data-i18n-placeholder,
 * or data-i18n-title attributes.
 *
 * SECURITY: data-i18n-html renders the locale string as HTML via innerHTML.
 * It is ONLY safe because locale strings are hardcoded developer content in
 * this file. Do NOT pass user input, server-provided strings, or any
 * untrusted content through a data-i18n-html key — doing so is XSS. Prefer
 * data-i18n (uses textContent) for any string that could include external
 * data, and keep the set of data-i18n-html keys minimal.
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

  // data-i18n-html renders the locale string as HTML. Only use for trusted
  // locale content — never pass user input through this attribute.
  var htmlEls = document.querySelectorAll('[data-i18n-html]');
  for (var h = 0; h < htmlEls.length; h++) {
    htmlEls[h].innerHTML = t(htmlEls[h].getAttribute('data-i18n-html'));
  }

  var titleEl = document.querySelector('title[data-i18n-title]');
  if (titleEl) {
    titleEl.textContent = t(titleEl.getAttribute('data-i18n-title'));
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
