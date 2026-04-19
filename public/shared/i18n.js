'use strict';

// i18n — lightweight internationalization for HexStacker Party
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
    waiting_for_players: 'Waiting for players...',
    start_n_players: { one: 'START ({count} player)', other: 'START ({count} players)' },
    start: 'START',

    // Buttons
    start_new_game: 'START NEW GAME',
    play_again: 'Play Again',
    new_game: 'New Game',
    continue_btn: 'Continue',
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
    end_step_1: 'Open <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> on a larger screen',
    end_step_2: 'Scan the QR code to use your phone as controller',
    game_in_progress: 'Game in progress. Please wait for New Game.',
    waiting_for_host_to_start: 'Waiting for {name} to start the game',
    waiting_for_host_to_continue: 'Waiting for {name} to continue',

    // Results
    n_lines: { one: '{count} line', other: '{count} lines' },
    level_n: 'Level {level}',

    // Misc
    player: 'Player',
    level_heading: 'Level',
    enter_name: 'Enter name...',
    copied: 'Copied',
    touchpad: 'Touchpad',
    privacy: 'Privacy',
    imprint: 'Imprint',
    back: 'Back',

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
    imprint_page_title: 'Imprint — HexStacker Party',
    privacy_page_title: 'Privacy — HexStacker Party',

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

    // Settings overlay
    settings_title: 'SETTINGS',
    settings_done: 'DONE',
    settings_game_music: 'Game Music',
    settings_touch_sounds: 'Touch Sounds',
    settings_haptics: 'Haptics',
    settings_haptics_hint: 'Vibration may not work on all devices',
    settings_haptic_off: 'Off',
    settings_haptic_light: 'Light',
    settings_haptic_medium: 'Med',
    settings_haptic_strong: 'Strong',
    settings_sensitivity: 'Sensitivity',

    // Display toolbar
    fullscreen: 'Fullscreen',

    // Action buttons without visible text
    pause: 'Pause',
    copy_url: 'Copy URL',
    level_minus: 'Decrease level',
    level_plus: 'Increase level',

    // Web Share API
    share_text: 'Play HexStacker Party with your friends',
  },

  de: {
    hold: 'HOLD', next: 'NEXT', level: 'LEVEL', lines: 'ZEILEN',
    ko: 'K.O.', go: 'LOS', scan_to_rejoin: 'ERNEUT SCANNEN',
    quad: 'QUAD!', triple: 'TRIPLE!', double: 'DOUBLE',
    scan_to_join: 'Scannen',
    waiting_for_players: 'Warte auf Spieler...',
    start_n_players: { one: 'START ({count} Spieler)', other: 'START ({count} Spieler)' },
    start: 'START', start_new_game: 'NEUES SPIEL',
    play_again: 'Nochmal',
    new_game: 'Neues Spiel',
    continue_btn: 'Weiter',
    continue_anyway: 'TROTZDEM WEITER',
    reconnect: 'NEU VERBINDEN', rejoin: 'ZURÜCK', join: 'BEITRETEN',
    reconnecting: 'VERBINDE NEU...', disconnected: 'GETRENNT',
    connecting: 'VERBINDE...', connection_lost: 'Verbindung verloren...',
    attempt_n_of_m: 'Versuch {attempt} von {max}',
    display_reconnecting: 'Display verbindet sich neu...',
    bad_connection: 'Schlechte Verbindung',
    paused: 'PAUSIERT', room_not_found: 'Raum nicht gefunden', game_full: 'Raum ist voll',
    game_ended: 'Spiel beendet',
    end_step_1: 'Öffne <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> auf einem größeren Bildschirm',
    end_step_2: 'Scanne den QR-Code, um dein Handy als Controller zu nutzen',
    game_in_progress: 'Spiel läuft. Warte auf die nächste Runde.',
    waiting_for_host_to_start: 'Warte auf {name}...',
    waiting_for_host_to_continue: 'Warte auf {name}...',
    n_lines: { one: '{count} Zeile', other: '{count} Zeilen' },
    level_n: 'Level {level}', player: 'Spieler', level_heading: 'Level',
    enter_name: 'Name...', copied: 'Kopiert', touchpad: 'Touchpad', privacy: 'Datenschutz',
    imprint: 'Impressum',
    imprint_title: 'IMPRESSUM',
    imprint_notice: 'Angaben gemäß § 5 DDG',
    imprint_contact: 'Kontakt',
    imprint_page_title: 'Impressum — HexStacker Party',
    privacy_page_title: 'Datenschutz — HexStacker Party',
    back: 'Zurück',
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
    gesture_drop: 'Fallen', gesture_hold: 'Halten',
    settings_title: 'EINSTELLUNGEN', settings_done: 'FERTIG',
    settings_game_music: 'Spielmusik', settings_touch_sounds: 'Touch-Sounds',
    settings_haptics: 'Vibration', settings_haptics_hint: 'Klappt nicht auf jedem Gerät',
    settings_haptic_off: 'Aus', settings_haptic_light: 'Leicht',
    settings_haptic_medium: 'Mittel', settings_haptic_strong: 'Stark',
    settings_sensitivity: 'Empfindlichkeit',
    fullscreen: 'Vollbild', pause: 'Pause', copy_url: 'URL kopieren',
    level_minus: 'Level runter', level_plus: 'Level rauf',
    share_text: 'Spiel HexStacker Party mit deinen Freunden',
  },

  fr: {
    hold: 'HOLD', next: 'SUIVANT', level: 'NIVEAU', lines: 'LIGNES',
    ko: 'K.O.', go: 'GO', scan_to_rejoin: 'SCANNER POUR REJOINDRE',
    quad: 'QUAD !', triple: 'TRIPLE !', double: 'DOUBLE',
    scan_to_join: 'Scanner pour rejoindre',
    waiting_for_players: 'En attente de joueurs...',
    start_n_players: { one: 'LANCER ({count} joueur)', other: 'LANCER ({count} joueurs)' },
    start: 'LANCER', start_new_game: 'NOUVELLE PARTIE',
    play_again: 'Rejouer',
    new_game: 'Nouvelle partie',
    continue_btn: 'Continuer',
    continue_anyway: 'CONTINUER QUAND MÊME',
    reconnect: 'SE RECONNECTER', rejoin: 'REJOINDRE', join: 'REJOINDRE',
    reconnecting: 'RECONNEXION', disconnected: 'DÉCONNECTÉ',
    connecting: 'CONNEXION...', connection_lost: 'Connexion perdue...',
    attempt_n_of_m: 'Tentative {attempt} sur {max}',
    display_reconnecting: 'Reconnexion de l\'écran...',
    bad_connection: 'Mauvaise connexion',
    paused: 'EN PAUSE', room_not_found: 'Salle introuvable', game_full: 'Salle pleine',
    game_ended: 'Partie terminée',
    end_step_1: 'Ouvre <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> sur un plus grand écran',
    end_step_2: 'Scanne le QR code pour utiliser ton téléphone comme manette',
    game_in_progress: 'Partie en cours. Attends la prochaine.',
    waiting_for_host_to_start: 'En attente de {name}...',
    waiting_for_host_to_continue: 'En attente de {name}...',
    n_lines: { one: '{count} ligne', other: '{count} lignes' },
    level_n: 'Niveau {level}', player: 'Joueur', level_heading: 'Niveau',
    enter_name: 'Entre ton nom...', copied: 'Copié', touchpad: 'Pavé tactile',
    privacy: 'Confidentialité', imprint: 'Mentions légales', back: 'Retour',
    hex_lines_level: 'Lignes {lines}  Niveau {level}',
    swipe: 'Glisser', tap: 'Appuyer', flick: 'Lancer',
    gesture_move: 'déplacer', gesture_rotate: 'tourner',
    stacked_by: 'Créé par Tim', music_by: 'Musique par FoxSynergy',
    gesture_drop: 'lâcher', gesture_hold: 'maintenir',
    settings_title: 'RÉGLAGES', settings_done: 'OK',
    settings_game_music: 'Musique', settings_touch_sounds: 'Sons tactiles',
    settings_haptics: 'Vibration', settings_haptics_hint: 'Peut ne pas marcher partout',
    settings_haptic_off: 'Off', settings_haptic_light: 'Léger',
    settings_haptic_medium: 'Moyen', settings_haptic_strong: 'Fort',
    settings_sensitivity: 'Sensibilité',
    fullscreen: 'Plein écran', pause: 'Pause', copy_url: 'Copier l\'URL',
    level_minus: 'Baisser le niveau', level_plus: 'Monter le niveau',
    share_text: 'Joue à HexStacker Party avec tes amis',
  },

  pt: {
    hold: 'HOLD', next: 'NEXT', level: 'NÍVEL', lines: 'LINHAS',
    ko: 'K.O.', go: 'JÁ!', scan_to_rejoin: 'ESCANEIA PARA VOLTAR',
    quad: 'QUAD!', triple: 'TRIPLE!', double: 'DOUBLE',
    scan_to_join: 'Escaneia para entrar',
    waiting_for_players: 'Aguardando jogadores...',
    start_n_players: { one: 'INICIAR ({count} jogador)', other: 'INICIAR ({count} jogadores)' },
    start: 'INICIAR', start_new_game: 'NOVO JOGO',
    play_again: 'Jogar novamente',
    new_game: 'Novo jogo',
    continue_btn: 'Continuar',
    continue_anyway: 'CONTINUAR MESMO ASSIM',
    reconnect: 'RECONECTAR', rejoin: 'VOLTAR', join: 'ENTRAR',
    reconnecting: 'RECONECTANDO', disconnected: 'DESCONECTADO',
    connecting: 'CONECTANDO...', connection_lost: 'Conexão perdida...',
    attempt_n_of_m: 'Tentativa {attempt} de {max}',
    display_reconnecting: 'Tela reconectando...',
    bad_connection: 'Conexão ruim',
    paused: 'PAUSADO', room_not_found: 'Sala não encontrada', game_full: 'Sala cheia',
    game_ended: 'Jogo encerrado',
    end_step_1: 'Abre <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> numa tela maior',
    end_step_2: 'Escaneia o QR para usar o telefone como controlador',
    game_in_progress: 'Jogo em andamento. Espera a próxima.',
    waiting_for_host_to_start: 'Esperando {name}...',
    waiting_for_host_to_continue: 'Esperando {name}...',
    n_lines: { one: '{count} linha', other: '{count} linhas' },
    level_n: 'Nível {level}', player: 'Jogador', level_heading: 'Nível',
    enter_name: 'Digita o nome...', copied: 'Copiado', touchpad: 'Touchpad',
    privacy: 'Privacidade', imprint: 'Aviso legal', back: 'Voltar',
    stacked_by: 'Criado por Tim', music_by: 'Música de FoxSynergy',
    hex_lines_level: 'Linhas {lines}  Nível {level}',
    swipe: 'Deslizar', tap: 'Tocar', flick: 'Lançar',
    gesture_move: 'mover', gesture_rotate: 'girar',
    gesture_drop: 'soltar', gesture_hold: 'segurar',
    settings_title: 'AJUSTES', settings_done: 'PRONTO',
    settings_game_music: 'Música do jogo', settings_touch_sounds: 'Sons de toque',
    settings_haptics: 'Vibração', settings_haptics_hint: 'Pode não funcionar em todos os aparelhos',
    settings_haptic_off: 'Off', settings_haptic_light: 'Fraca',
    settings_haptic_medium: 'Média', settings_haptic_strong: 'Forte',
    settings_sensitivity: 'Sensibilidade',
    fullscreen: 'Tela cheia', pause: 'Pausar', copy_url: 'Copiar URL',
    level_minus: 'Diminuir nível', level_plus: 'Aumentar nível',
    share_text: 'Joga HexStacker Party com seus amigos',
  },

  es: {
    hold: 'HOLD', next: 'NEXT', level: 'NIVEL', lines: 'LÍNEAS',
    ko: 'K.O.', go: '¡YA!', scan_to_rejoin: 'ESCANEA PARA VOLVER',
    quad: '¡QUAD!', triple: '¡TRIPLE!', double: 'DOBLE',
    scan_to_join: 'Escanea para unirte',
    waiting_for_players: 'Esperando jugadores...',
    start_n_players: { one: 'INICIAR ({count} jugador)', other: 'INICIAR ({count} jugadores)' },
    start: 'INICIAR', start_new_game: 'NUEVA PARTIDA',
    play_again: 'Jugar de nuevo',
    new_game: 'Nueva partida',
    continue_btn: 'Continuar',
    continue_anyway: 'CONTINUAR DE TODAS FORMAS',
    reconnect: 'RECONECTAR', rejoin: 'VOLVER', join: 'UNIRSE',
    reconnecting: 'RECONECTANDO', disconnected: 'DESCONECTADO',
    connecting: 'CONECTANDO...', connection_lost: 'Conexión perdida...',
    attempt_n_of_m: 'Intento {attempt} de {max}',
    display_reconnecting: 'Pantalla reconectando...',
    bad_connection: 'Mala conexión',
    paused: 'PAUSA', room_not_found: 'Sala no encontrada', game_full: 'Sala llena',
    game_ended: 'Partida finalizada',
    end_step_1: 'Abre <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> en una pantalla más grande',
    end_step_2: 'Escanea el código QR para usar tu teléfono como control',
    game_in_progress: 'Partida en curso. Espera la próxima.',
    waiting_for_host_to_start: 'Esperando a {name}...',
    waiting_for_host_to_continue: 'Esperando a {name}...',
    n_lines: { one: '{count} línea', other: '{count} líneas' },
    level_n: 'Nivel {level}', player: 'Jugador', level_heading: 'Nivel',
    enter_name: 'Escribe tu nombre...', copied: 'Copiado', touchpad: 'Touchpad',
    privacy: 'Privacidad', imprint: 'Aviso legal', back: 'Volver',
    hex_lines_level: 'Líneas {lines}  Nivel {level}',
    swipe: 'Deslizar', tap: 'Tocar', flick: 'Lanzar',
    gesture_move: 'mover', gesture_rotate: 'girar',
    stacked_by: 'Creado por Tim', music_by: 'Música de FoxSynergy',
    gesture_drop: 'soltar', gesture_hold: 'guardar',
    settings_title: 'AJUSTES', settings_done: 'LISTO',
    settings_game_music: 'Música', settings_touch_sounds: 'Sonidos táctiles',
    settings_haptics: 'Vibración', settings_haptics_hint: 'Puede no funcionar en todos los dispositivos',
    settings_haptic_off: 'Off', settings_haptic_light: 'Suave',
    settings_haptic_medium: 'Media', settings_haptic_strong: 'Fuerte',
    settings_sensitivity: 'Sensibilidad',
    fullscreen: 'Pantalla completa', pause: 'Pausa', copy_url: 'Copiar URL',
    level_minus: 'Bajar nivel', level_plus: 'Subir nivel',
    share_text: 'Juega a HexStacker Party con tus amigos',
  },

  zh: {
    hold: '暂存', next: '下一个', level: '等级', lines: '行数',
    ko: 'K.O.', go: '开始', scan_to_rejoin: '扫码重新加入',
    quad: '四连消!', triple: '三连消!', double: '二连消',
    scan_to_join: '扫码加入',
    waiting_for_players: '等待玩家加入...',
    start_n_players: { other: '开始 ({count} 位玩家)' },
    start: '开始', start_new_game: '开始新游戏',
    play_again: '再来一局',
    new_game: '新游戏',
    continue_btn: '继续',
    continue_anyway: '仍然继续',
    reconnect: '重新连接', rejoin: '重新加入', join: '加入',
    reconnecting: '正在重连', disconnected: '已断开连接',
    connecting: '正在连接...', connection_lost: '连接已断开...',
    attempt_n_of_m: '第 {attempt} 次尝试，共 {max} 次',
    display_reconnecting: '显示屏正在重连...',
    bad_connection: '连接不佳',
    paused: '已暂停', room_not_found: '房间未找到', game_full: '房间已满',
    game_ended: '游戏已结束',
    end_step_1: '在更大的屏幕上打开 <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a>',
    end_step_2: '扫描二维码，把手机当作控制器',
    game_in_progress: '游戏中，等下一局',
    waiting_for_host_to_start: '等待 {name} 开始游戏',
    waiting_for_host_to_continue: '等待 {name} 继续',
    n_lines: { other: '{count} 行' },
    level_n: '等级 {level}', player: '玩家', level_heading: '等级',
    enter_name: '输入名字...', copied: '已复制', touchpad: '触控板', privacy: '隐私', imprint: '法律声明', back: '返回',
    hex_lines_level: '行数 {lines}  等级 {level}',
    swipe: '滑动', tap: '点按', flick: '快划',
    gesture_move: '移动', gesture_rotate: '旋转',
    stacked_by: '开发：Tim', music_by: '音乐：FoxSynergy',
    gesture_drop: '落下', gesture_hold: '暂存',
    settings_title: '设置', settings_done: '完成',
    settings_game_music: '游戏音乐', settings_touch_sounds: '触控声音',
    settings_haptics: '振动', settings_haptics_hint: '部分设备可能不支持',
    settings_haptic_off: '关', settings_haptic_light: '弱',
    settings_haptic_medium: '中', settings_haptic_strong: '强',
    settings_sensitivity: '灵敏度',
    fullscreen: '全屏', pause: '暂停', copy_url: '复制 URL',
    level_minus: '降低等级', level_plus: '提升等级',
    share_text: '和朋友一起玩 HexStacker Party',
  },

  ja: {
    hold: 'ホールド', next: 'ネクスト', level: 'レベル', lines: 'ライン',
    ko: 'K.O.', go: 'GO', scan_to_rejoin: 'スキャンで再参加',
    quad: '4ライン!', triple: '3ライン!', double: '2ライン',
    scan_to_join: 'スキャンして参加',
    waiting_for_players: 'プレイヤー待ってる...',
    start_n_players: { other: 'スタート ({count}人)' },
    start: 'スタート', start_new_game: '新しいゲームを開始',
    play_again: 'もう一度',
    new_game: '新しいゲーム',
    continue_btn: '続ける',
    continue_anyway: 'このまま続ける',
    reconnect: '再接続', rejoin: '再参加', join: '参加',
    reconnecting: '再接続中...', disconnected: '切断された',
    connecting: '接続中...', connection_lost: '接続が切れた...',
    attempt_n_of_m: '再試行 {attempt}/{max}',
    display_reconnecting: 'ディスプレイ再接続中...',
    bad_connection: '接続不良',
    paused: '一時停止', room_not_found: 'ルームが見つからない', game_full: 'ルームが満員',
    game_ended: 'ゲーム終了',
    end_step_1: 'より大きな画面で <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> を開く',
    end_step_2: 'QRコードをスキャンして、スマートフォンをコントローラーとして使う',
    game_in_progress: 'ゲーム中。次のゲームまで待ってね',
    waiting_for_host_to_start: '{name}が始めるのを待ってるよ',
    waiting_for_host_to_continue: '{name}が続けるのを待ってるよ',
    n_lines: { other: '{count}ライン' },
    level_n: 'レベル {level}', player: 'プレイヤー', level_heading: 'レベル',
    enter_name: '名前を入力...', copied: 'コピー完了', touchpad: 'タッチパッド',
    privacy: 'プライバシー', imprint: '運営者情報', back: '戻る',
    hex_lines_level: 'ライン {lines}  レベル {level}',
    swipe: 'スワイプ', tap: 'タップ', flick: 'フリック',
    gesture_move: '移動', gesture_rotate: '回転',
    stacked_by: '開発：Tim', music_by: '音楽：FoxSynergy',
    gesture_drop: 'ドロップ', gesture_hold: 'ホールド',
    settings_title: '設定', settings_done: 'OK',
    settings_game_music: 'ゲーム音楽', settings_touch_sounds: 'タッチ音',
    settings_haptics: '振動', settings_haptics_hint: '端末によっては効かないかも',
    settings_haptic_off: 'オフ', settings_haptic_light: '弱',
    settings_haptic_medium: '中', settings_haptic_strong: '強',
    settings_sensitivity: '感度',
    fullscreen: '全画面', pause: '一時停止', copy_url: 'URLをコピー',
    level_minus: 'レベルを下げる', level_plus: 'レベルを上げる',
    share_text: '友達と HexStacker Party で遊ぼう',
  },

  ko: {
    hold: '홀드', next: '다음', level: '레벨', lines: '줄',
    ko: 'K.O.', go: 'GO', scan_to_rejoin: '스캔하여 재참가',
    quad: '4줄!', triple: '3줄!', double: '2줄',
    scan_to_join: '스캔하여 참가',
    waiting_for_players: '플레이어를 기다리는 중...',
    start_n_players: { other: '시작 ({count}명)' },
    start: '시작', start_new_game: '새 게임 시작',
    play_again: '다시 하기',
    new_game: '새 게임',
    continue_btn: '계속',
    continue_anyway: '그래도 계속',
    reconnect: '재연결', rejoin: '재참가', join: '참가',
    reconnecting: '재연결 중', disconnected: '연결 끊김',
    connecting: '연결 중...', connection_lost: '연결 끊겼어...',
    attempt_n_of_m: '시도 {attempt}/{max}',
    display_reconnecting: '디스플레이 재연결 중...',
    bad_connection: '연결 불량',
    paused: '일시정지', room_not_found: '방을 찾을 수 없어', game_full: '방이 가득 찼어',
    game_ended: '게임 종료',
    end_step_1: '더 큰 화면에서 <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> 열기',
    end_step_2: 'QR 코드를 스캔해서 휴대폰을 컨트롤러로 써',
    game_in_progress: '게임 중. 새 게임 기다려',
    waiting_for_host_to_start: '{name} 기다리는 중...',
    waiting_for_host_to_continue: '{name} 기다리는 중...',
    n_lines: { other: '{count}줄' },
    level_n: '레벨 {level}', player: '플레이어', level_heading: '레벨',
    enter_name: '이름 입력...', copied: '복사됨', touchpad: '터치패드', privacy: '개인정보', imprint: '법적 고지', back: '돌아가기',
    hex_lines_level: '줄 {lines}  레벨 {level}',
    swipe: '스와이프', tap: '탭', flick: '플릭',
    gesture_move: '이동', gesture_rotate: '회전',
    stacked_by: '개발: Tim', music_by: '음악: FoxSynergy',
    gesture_drop: '드롭', gesture_hold: '홀드',
    settings_title: '설정', settings_done: '완료',
    settings_game_music: '게임 음악', settings_touch_sounds: '터치 소리',
    settings_haptics: '진동', settings_haptics_hint: '일부 기기에서는 안 될 수 있어',
    settings_haptic_off: '끔', settings_haptic_light: '약',
    settings_haptic_medium: '중', settings_haptic_strong: '강',
    settings_sensitivity: '감도',
    fullscreen: '전체화면', pause: '일시정지', copy_url: 'URL 복사',
    level_minus: '레벨 내리기', level_plus: '레벨 올리기',
    share_text: '친구들과 HexStacker Party 해봐',
  },

  ru: {
    hold: 'ХОЛД', next: 'ДАЛЕЕ', level: 'УРОВЕНЬ', lines: 'ЛИНИИ',
    ko: 'K.O.', go: 'СТАРТ', scan_to_rejoin: 'СКАНИРУЙ И ВЕРНИСЬ',
    quad: 'QUAD!', triple: 'TRIPLE!', double: 'DOUBLE',
    scan_to_join: 'Сканируй и заходи',
    waiting_for_players: 'Ждём игроков...',
    start_n_players: {
      one: 'СТАРТ ({count} игрок)', few: 'СТАРТ ({count} игрока)',
      many: 'СТАРТ ({count} игроков)', other: 'СТАРТ ({count} игроков)'
    },
    start: 'СТАРТ', start_new_game: 'НОВАЯ ИГРА',
    play_again: 'Играть снова',
    new_game: 'Новая игра',
    continue_btn: 'Продолжить',
    continue_anyway: 'ВСЁ РАВНО ДАЛЬШЕ',
    reconnect: 'ПЕРЕПОДКЛЮЧИТЬСЯ', rejoin: 'ВЕРНУТЬСЯ', join: 'ВОЙТИ',
    reconnecting: 'ПЕРЕПОДКЛЮЧЕНИЕ', disconnected: 'ОТКЛЮЧЕНО',
    connecting: 'ПОДКЛЮЧЕНИЕ...', connection_lost: 'Соединение потеряно...',
    attempt_n_of_m: 'Попытка {attempt} из {max}',
    display_reconnecting: 'Дисплей переподключается...',
    bad_connection: 'Плохое соединение',
    paused: 'ПАУЗА', room_not_found: 'Комната не найдена', game_full: 'Комната заполнена',
    game_ended: 'Игра завершена',
    end_step_1: 'Открой <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> на большом экране',
    end_step_2: 'Отсканируй QR-код и используй телефон как контроллер',
    game_in_progress: 'Игра идёт. Жди новую.',
    waiting_for_host_to_start: 'Ждём {name}...',
    waiting_for_host_to_continue: 'Ждём {name}...',
    n_lines: {
      one: '{count} линия', few: '{count} линии',
      many: '{count} линий', other: '{count} линий'
    },
    level_n: 'Уровень {level}', player: 'Игрок', level_heading: 'Уровень',
    enter_name: 'Введи имя...', copied: 'Скопировано', touchpad: 'Тачпад',
    privacy: 'Конфиденциальность', imprint: 'Выходные данные', back: 'Назад',
    hex_lines_level: 'Линии {lines}  Уровень {level}',
    swipe: 'Свайп', tap: 'Нажатие', flick: 'Смахивание',
    gesture_move: 'двигать', gesture_rotate: 'вращать',
    stacked_by: 'Разработка: Tim', music_by: 'Музыка: FoxSynergy',
    gesture_drop: 'бросать', gesture_hold: 'держать',
    settings_title: 'НАСТРОЙКИ', settings_done: 'ГОТОВО',
    settings_game_music: 'Музыка', settings_touch_sounds: 'Звуки касаний',
    settings_haptics: 'Вибрация', settings_haptics_hint: 'Работает не на всех устройствах',
    settings_haptic_off: 'Выкл', settings_haptic_light: 'Слабо',
    settings_haptic_medium: 'Средне', settings_haptic_strong: 'Сильно',
    settings_sensitivity: 'Чувствительность',
    fullscreen: 'Полный экран', pause: 'Пауза', copy_url: 'Скопировать URL',
    level_minus: 'Уменьшить уровень', level_plus: 'Повысить уровень',
    share_text: 'Играй в HexStacker Party с друзьями',
  },

  it: {
    hold: 'HOLD', next: 'NEXT', level: 'LIVELLO', lines: 'LINEE',
    ko: 'K.O.', go: 'VIA!', scan_to_rejoin: 'SCANSIONA PER RIENTRARE',
    quad: 'QUAD!', triple: 'TRIPLE!', double: 'DOUBLE',
    scan_to_join: 'Scansiona per unirti',
    waiting_for_players: 'In attesa di giocatori...',
    start_n_players: { one: 'AVVIA ({count} giocatore)', other: 'AVVIA ({count} giocatori)' },
    start: 'AVVIA', start_new_game: 'NUOVA PARTITA',
    play_again: 'Gioca ancora',
    new_game: 'Nuova partita',
    continue_btn: 'Continua',
    continue_anyway: 'CONTINUA COMUNQUE',
    reconnect: 'RICONNETTI', rejoin: 'RIENTRA', join: 'UNISCITI',
    reconnecting: 'RICONNESSIONE', disconnected: 'DISCONNESSO',
    connecting: 'CONNESSIONE...', connection_lost: 'Connessione persa...',
    attempt_n_of_m: 'Tentativo {attempt} di {max}',
    display_reconnecting: 'Display in riconnessione...',
    bad_connection: 'Connessione scarsa',
    paused: 'IN PAUSA', room_not_found: 'Stanza non trovata', game_full: 'Stanza piena',
    game_ended: 'Partita terminata',
    end_step_1: 'Apri <a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> su uno schermo più grande',
    end_step_2: 'Scansiona il QR code per usare il telefono come controller',
    game_in_progress: 'Partita in corso. Aspetta la prossima.',
    waiting_for_host_to_start: 'In attesa di {name}...',
    waiting_for_host_to_continue: 'In attesa di {name}...',
    n_lines: { one: '{count} linea', other: '{count} linee' },
    level_n: 'Livello {level}', player: 'Giocatore', level_heading: 'Livello',
    enter_name: 'Inserisci nome...', copied: 'Copiato', touchpad: 'Touchpad',
    privacy: 'Privacy', imprint: 'Note legali', back: 'Indietro',
    stacked_by: 'Creato da Tim', music_by: 'Musica di FoxSynergy',
    hex_lines_level: 'Linee {lines}  Livello {level}',
    swipe: 'Scorrere', tap: 'Toccare', flick: 'Lanciare',
    gesture_move: 'muovere', gesture_rotate: 'ruotare',
    gesture_drop: 'rilasciare', gesture_hold: 'tenere',
    settings_title: 'IMPOSTAZIONI', settings_done: 'OK',
    settings_game_music: 'Musica', settings_touch_sounds: 'Suoni touch',
    settings_haptics: 'Vibrazione', settings_haptics_hint: 'Potrebbe non funzionare su tutti i dispositivi',
    settings_haptic_off: 'Off', settings_haptic_light: 'Lieve',
    settings_haptic_medium: 'Media', settings_haptic_strong: 'Forte',
    settings_sensitivity: 'Sensibilità',
    fullscreen: 'Schermo intero', pause: 'Pausa', copy_url: 'Copia URL',
    level_minus: 'Diminuisci livello', level_plus: 'Aumenta livello',
    share_text: 'Gioca a HexStacker Party con i tuoi amici',
  },

  tr: {
    hold: 'HOLD', next: 'NEXT', level: 'SEVİYE', lines: 'SATIR',
    ko: 'K.O.', go: 'BAŞLA!', scan_to_rejoin: 'TEKRAR KATILMAK İÇİN TARA',
    quad: 'DÖRTLÜ!', triple: 'ÜÇLÜ!', double: 'İKİLİ',
    scan_to_join: 'Katılmak için tara',
    waiting_for_players: 'Oyuncular bekleniyor...',
    start_n_players: { one: 'BAŞLAT ({count} oyuncu)', other: 'BAŞLAT ({count} oyuncu)' },
    start: 'BAŞLAT', start_new_game: 'YENİ OYUN BAŞLAT',
    play_again: 'Tekrar oyna',
    new_game: 'Yeni oyun',
    continue_btn: 'Devam',
    continue_anyway: 'YİNE DE DEVAM ET',
    reconnect: 'YENİDEN BAĞLAN', rejoin: 'TEKRAR KATIL', join: 'KATIL',
    reconnecting: 'YENİDEN BAĞLANIYOR', disconnected: 'BAĞLANTI KESİLDİ',
    connecting: 'BAĞLANIYOR...', connection_lost: 'Bağlantı kesildi...',
    attempt_n_of_m: 'Deneme {attempt}/{max}',
    display_reconnecting: 'Ekran yeniden bağlanıyor...',
    bad_connection: 'Kötü bağlantı',
    paused: 'DURAKLATILDI', room_not_found: 'Oda bulunamadı', game_full: 'Oda dolu',
    game_ended: 'Oyun sona erdi',
    end_step_1: '<a href="https://hexstacker.com" id="end-step-1-link" class="end-link">hexstacker.com</a> adresini daha büyük bir ekranda aç',
    end_step_2: 'Telefonunu kumanda olarak kullanmak için QR kodu tara',
    game_in_progress: 'Oyun devam ediyor. Yeni oyunu bekle.',
    waiting_for_host_to_start: '{name} oyunu başlatana kadar bekle',
    waiting_for_host_to_continue: '{name} devam edene kadar bekle',
    n_lines: { one: '{count} satır', other: '{count} satır' },
    level_n: 'Seviye {level}', player: 'Oyuncu', level_heading: 'Seviye',
    enter_name: 'İsim gir...', copied: 'Kopyalandı', touchpad: 'Touchpad',
    privacy: 'Gizlilik', imprint: 'Künye', back: 'Geri',
    stacked_by: 'Yapımcı: Tim', music_by: 'Müzik: FoxSynergy',
    hex_lines_level: 'Satır {lines}  Seviye {level}',
    swipe: 'Kaydır', tap: 'Dokun', flick: 'Fırlat',
    gesture_move: 'hareket ettir', gesture_rotate: 'döndür',
    gesture_drop: 'bırak', gesture_hold: 'tut',
    settings_title: 'AYARLAR', settings_done: 'TAMAM',
    settings_game_music: 'Oyun müziği', settings_touch_sounds: 'Dokunma sesleri',
    settings_haptics: 'Titreşim', settings_haptics_hint: 'Her cihazda çalışmayabilir',
    settings_haptic_off: 'Kapalı', settings_haptic_light: 'Hafif',
    settings_haptic_medium: 'Orta', settings_haptic_strong: 'Güçlü',
    settings_sensitivity: 'Hassasiyet',
    fullscreen: 'Tam ekran', pause: 'Duraklat', copy_url: 'URL\'yi kopyala',
    level_minus: 'Seviyeyi azalt', level_plus: 'Seviyeyi artır',
    share_text: 'Arkadaşlarınla HexStacker Party oyna',
  }
};

// --- Internal state ---
var _locale = 'en';
var _strings = LOCALES.en;
var _pluralRules = null;

function _initRules() {
  if (typeof Intl !== 'undefined' && Intl.PluralRules) {
    try {
      _pluralRules = new Intl.PluralRules(_locale);
    } catch (e) {
      _pluralRules = null;
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

  var arias = document.querySelectorAll('[data-i18n-aria-label]');
  for (var a = 0; a < arias.length; a++) {
    arias[a].setAttribute('aria-label', t(arias[a].getAttribute('data-i18n-aria-label')));
  }

  // data-i18n-html renders the locale string as HTML. Only use for trusted
  // locale content — never pass user input through this attribute.
  var htmlEls = document.querySelectorAll('[data-i18n-html]');
  for (var h = 0; h < htmlEls.length; h++) {
    htmlEls[h].innerHTML = t(htmlEls[h].getAttribute('data-i18n-html'));
  }

  // data-i18n-title: sets textContent on the <title> element, sets the
  // `title` attribute (hover tooltip) on any other element.
  var titleEls = document.querySelectorAll('[data-i18n-title]');
  for (var k = 0; k < titleEls.length; k++) {
    var titleEl = titleEls[k];
    var translated = t(titleEl.getAttribute('data-i18n-title'));
    if (titleEl.tagName === 'TITLE') {
      titleEl.textContent = translated;
    } else {
      titleEl.setAttribute('title', translated);
    }
  }

  document.documentElement.lang = _locale;
}

/**
 * Auto-detect locale from URL param → navigator.language → 'en'.
 */
function detectLocale() {
  var lang = null;

  // 1. URL parameter ?lang=xx
  if (typeof URLSearchParams !== 'undefined' && typeof location !== 'undefined') {
    try { lang = new URLSearchParams(location.search).get('lang'); } catch (e) { /* ignore */ }
  }

  // 2. Browser language
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
  module.exports = { t: t, setLocale: setLocale, getLocale: getLocale, translatePage: translatePage, detectLocale: detectLocale, LOCALES: LOCALES };
}
