import type { ConfigGroup } from 'cortico/core/types.ts';

export interface Sts2ConfigSection {
  enabled: boolean;
  /** 桥的地址；mod 默认 18080。 */
  baseUrl: string;
  statePath: string;
  actionPath: string;
  eventPath: string;
  capturePath: string;
  /** 用 steam:// 拉起游戏（可选）。 */
  launch: boolean;
  connectTimeoutMs: number;
  /** 启动时先试多久，失败就挂 error 灯、后台重试，不阻塞 Core 启动。 */
  connectAttemptMs: number;
  /** 后台重连间隔。 */
  retryIntervalMs: number;
  stateTimeoutMs: number;
  actionTimeoutMs: number;
  /** SSE 不可用时的轮询间隔。 */
  pollIntervalMs: number;
  /** 状态事件的节流下限，避免每帧都叫醒她。 */
  stateEventThrottleMs: number;
  /** 桥没给任何动作时停手等人工，而不是瞎猜。 */
  pauseOnUnknownScreen: boolean;
  /** 空动作持续多久才判定为「这一屏不会」（界面切换的中间态会短暂没有动作）。 */
  blockedGraceMs: number;
  /** 一轮动作后若游戏仍在等输入，补一条提醒。 */
  remindAtTurnEnd: boolean;
  /** 没得选的屏（只剩"继续/结束回合"）自动替她点，别让流程停在那儿。 */
  autoAdvance: boolean;
  /** 同一个操作连续失败几次就停手喊人。 */
  maxRejectsBeforeStop: number;
  /** 游戏在等输入、她却一直没有动作时，多久提醒一次（0 = 关掉）。 */
  idleNudgeMs: number;
  /** 战斗里动作清单空掉（敌方回合/动画）时，等多久才算真的卡住。 */
  combatGraceMs: number;
  /** 读存档里的读档次数与 seed 来判断回档（读不到会自动退回纯内存判定）。 */
  readSave: boolean;
  /** 存档路径；留空表示自动在 %APPDATA%/SlayTheSpire2 下找。 */
  savePath: string;
  /** 两次"局面和记忆对不上"的提示之间的最小间隔。 */
  driftNoticeMs: number;
  /** 偶尔说一句：off 闭嘴，rare 稀疏，normal 稍多。 */
  chatter: 'off' | 'rare' | 'normal';
  /** 闲话怎么出声：direct = 世界直接送到桌宠气泡（不进模型、0 token），model = 发 murmur 事件让模型说。 */
  chatterDelivery: 'direct' | 'model';
  /** 台词文件；留空用 dataDir/chatter.json（首次启动会写一份默认的）。 */
  chatterLinesFile: string;
  /** 直连气泡时加在每句末尾的口癖；留空不加。 */
  chatterSuffix: string;
  chatterWinChance: number;
  chatterHurtChance: number;
  chatterCooldownMs: number;
  /** 把桥自带的战斗求解器当注记贴进快照（只建议，不执行）。 */
  solver: boolean;
  solverPath: string;
  solverTimeoutMs: number;
  solverMinConfidence: number;
  /** 两次向求解器要"下一步建议"之间的最小间隔：它一次搜索能吃满 0.7 秒 CPU。 */
  solverPrefetchMs: number;
  /** 战斗里由求解器逐步接管，打完一整个回合都不叫醒模型，只在需要决策时交回。 */
  solverAutoplay: boolean;
  /** 一次接管最多执行几步（防死循环）。 */
  solverAutoplayMaxSteps: number;
  /** 生命低于这个百分比就交回模型。 */
  solverAutoplayStopHpPct: number;
  /** 每场战斗结束后发一条摘要事件（一条事件 = 一次模型调用）。 */
  solverAutoplaySummary: boolean;
  /** 同一局面在这么短时间内被重复观察时，只回一句话，不重发状态。 */
  observeThrottleMs: number;
  /** 把 sts2_observe 暴露给模型；默认开：求解器交回/断线恢复时她需要它拿新状态码。 */
  exposeObserve: boolean;
  /** 把排障工具（sts2_probe）暴露给模型；默认关。 */
  devTools: boolean;
  /** 单步 do 之后在回执里提示改用 sts2_play 批处理。 */
  batchHint: boolean;
  /** 多人局地图先压这么久再推给她，给队友投票的时间；0 表示一直等到队友先投。 */
  coopRouteWaitMs: number;
  /** 主页/选角色时安静：不推局面、不自己开局，等玩家发话。 */
  quietOnMenu: boolean;
  /** 她一轮还没走完时，新局面先攒着，等这一轮结束再推（少打断、少一轮模型调用）。 */
  queueStateEvents: boolean;
  /** 判成卡住之后多久自己回读一次（桥经常只是抖一帧）。 */
  blockedRetryMs: number;
  /** 断线多久才算"真断了"并通知模型；短暂抖动重连回来就当没发生。 */
  connectionQuietMs: number;
}

export const STS2_DEFAULTS: Sts2ConfigSection = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:18080',
  statePath: '/state',
  actionPath: '/action',
  eventPath: '/events/stream',
  capturePath: '/capture',
  launch: false,
  connectTimeoutMs: 60000,
  connectAttemptMs: 1500,
  retryIntervalMs: 5000,
  stateTimeoutMs: 5000,
  actionTimeoutMs: 30000,
  pollIntervalMs: 1200,
  stateEventThrottleMs: 600,
  pauseOnUnknownScreen: true,
  blockedGraceMs: 1500,
  remindAtTurnEnd: true,
  autoAdvance: true,
  maxRejectsBeforeStop: 2,
  idleNudgeMs: 10000,
  combatGraceMs: 9000,
  readSave: true,
  savePath: '',
  driftNoticeMs: 60000,
  chatter: 'rare',
  chatterDelivery: 'direct',
  chatterLinesFile: '',
  chatterSuffix: '，库…',
  chatterWinChance: 0.35,
  chatterHurtChance: 0.3,
  chatterCooldownMs: 45000,
  solver: true,
  solverPath: '/solver/plan',
  solverTimeoutMs: 6000,
  solverMinConfidence: 0.6,
  solverPrefetchMs: 2000,
  solverAutoplay: false,
  solverAutoplayMaxSteps: 12,
  solverAutoplayStopHpPct: 30,
  solverAutoplaySummary: true,
  observeThrottleMs: 3000,
  exposeObserve: true,
  devTools: false,
  batchHint: true,
  coopRouteWaitMs: 4000,
  quietOnMenu: true,
  queueStateEvents: true,
  blockedRetryMs: 4000,
  connectionQuietMs: 3000,
};

export const STS2_CONFIG_GROUP: ConfigGroup = {
  id: 'world:sts-2',
  owner: 'world:sts-2',
  schema: {
    type: 'object',
    title: '杀戮尖塔 2',
    description: '通过游戏内 mod 的 HTTP 桥读局面、下动作。mod 未安装时这里连不上，属正常。',
    properties: {
      'worlds.sts-2.baseUrl': {
        type: 'string', title: '桥地址',
        description: '游戏内 mod 的监听地址；默认 http://127.0.0.1:18080（mod 侧可用 STS2_API_PORT 改）。',
        'x-hot': false,
      },
      'worlds.sts-2.launch': {
        type: 'boolean', title: '挂载时启动游戏',
        description: '用 steam://rungameid/2868840 拉起游戏。停用 World 时不会关游戏。',
        'x-hot': false,
      },
      'worlds.sts-2.retryIntervalMs': {
        type: 'integer', minimum: 500, maximum: 120000, title: '重连间隔',
        description: '没连上桥时多久重试一次；游戏开起来后会自动接上。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.connectTimeoutMs': {
        type: 'integer', minimum: 1000, maximum: 600000, title: '启动连接期限', 'x-suffix': 'ms', 'x-hot': false,
      },
      'worlds.sts-2.actionTimeoutMs': {
        type: 'integer', minimum: 1000, maximum: 180000, title: '动作结算期限',
        description: '求解器可能算到 8 秒（Deep 预算更久），留够余量。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.stateTimeoutMs': {
        type: 'integer', minimum: 500, maximum: 60000, title: '读状态期限', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.stateEventThrottleMs': {
        type: 'integer', minimum: 0, maximum: 10000, title: '状态事件节流',
        description: '两次状态推送之间的最小间隔；0 表示不限。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.blockedGraceMs': {
        type: 'integer', minimum: 0, maximum: 30000, title: '空动作宽限',
        description: '桥短时间内没有动作（界面动画、结算中间态）不算卡住；超过这个时长才提醒人。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.pauseOnUnknownScreen': {
        type: 'boolean', title: '未知界面停手等人',
        description: '桥没有给出任何动作时，发一条提醒后停住，等你手动点完。', 'x-hot': true,
      },
      'worlds.sts-2.remindAtTurnEnd': {
        type: 'boolean', title: '轮末提醒',
        description: '她这一轮动过手、游戏仍在等输入时，补一条提醒；不动手就不提醒。', 'x-hot': true,
      },
      'worlds.sts-2.pollIntervalMs': {
        type: 'integer', minimum: 200, maximum: 10000, title: '轮询间隔',
        description: '事件流断开时的兜底读取间隔。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.autoAdvance': {
        type: 'boolean', title: '没得选就替她点',
        description: '只剩“结束回合 / 领完继续 / 打开宝箱 / 离开商店”这类推进动作时自动执行；有取舍的屏永远停下等她。', 'x-hot': true,
      },
      'worlds.sts-2.maxRejectsBeforeStop': {
        type: 'integer', minimum: 1, maximum: 10, title: '连续失败几次停手',
        description: '同一个局面下同一个操作被桥连续拒绝到这个次数，就停手并在面板上说一句。', 'x-hot': true,
      },
      'worlds.sts-2.idleNudgeMs': {
        type: 'integer', minimum: 0, maximum: 600000, title: '没动静的提醒间隔',
        description: '游戏在等输入、她却一直没有动作时，先提醒一次，再一个间隔后停住。0 表示关。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.combatGraceMs': {
        type: 'integer', minimum: 1000, maximum: 60000, title: '战斗里的空动作宽限',
        description: '敌方回合、动画期间桥会短暂不给动作，这是正常的；等这么久还没动作才算卡住。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.readSave': {
        type: 'boolean', title: '读存档判断读档',
        description: '读 current_run.save 里的读档次数与 seed；读不到时自动退回纯内存判定，不影响其他功能。', 'x-hot': true,
      },
      'worlds.sts-2.savePath': {
        type: 'string', title: '存档路径',
        description: '留空表示自动在 %APPDATA%/SlayTheSpire2 下找最新的 current_run.save。', 'x-hot': false,
      },
      'worlds.sts-2.driftNoticeMs': {
        type: 'integer', minimum: 0, maximum: 3600000, title: '“对不上”提示间隔',
        description: '局面和她的记忆对不上（但没到回档）时的提示最小间隔。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.chatter': {
        type: 'string', enum: ['off', 'rare', 'normal'], title: '偶尔说一句',
        description: '战斗结束夸一句、挨打哼一声。off 完全不说话；rare 每层偶尔一两次；normal 再活跃一些。', 'x-hot': true,
      },
      'worlds.sts-2.chatterDelivery': {
        type: 'string', enum: ['direct', 'model'], title: '闲话怎么出声',
        description: 'direct：世界直接把台词送进桌宠气泡，不进模型、不花 token；model：发 murmur 事件让模型复述（慢几秒，每次一整轮调用）。',
        'x-hot': true,
      },
      'worlds.sts-2.chatterSuffix': {
        type: 'string', title: '句尾口癖',
        description: '直连气泡时自动加在每句末尾（会把原来的句号换成它）；留空不加。走模型时由模型自己带口癖，这里不生效。',
        'x-hot': true,
      },
      'worlds.sts-2.chatterLinesFile': {
        type: 'string', title: '台词文件',
        description: '台词池 JSON 的路径；留空用数据目录下的 chatter.json（首次启动自动写一份默认的，改完保存即生效；换路径需重启）。',
        'x-hot': false,
      },
      'worlds.sts-2.chatterWinChance': {
        type: 'number', minimum: 0, maximum: 1, multipleOf: 0.05, title: '打完夸一句的概率',
        description: '每场战斗结束时的触发概率；normal 档会再乘 1.5。调低这个或拉长下面的冷却，都能让她更安静。', 'x-hot': true,
      },
      'worlds.sts-2.chatterHurtChance': {
        type: 'number', minimum: 0, maximum: 1, multipleOf: 0.05, title: '挨打说一句的概率',
        description: '一次掉 5 点以上血时的触发概率；normal 档会再乘 1.5。', 'x-hot': true,
      },
      'worlds.sts-2.chatterCooldownMs': {
        type: 'integer', minimum: 0, maximum: 600000, title: '两句之间的最短间隔',
        description: '两次"偶尔一句"之间至少隔这么久，防止刷屏；直连气泡延迟很低，靠它压频率。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.solver': {
        type: 'boolean', title: '贴求解器建议',
        description: '战斗里读桥自带的求解器，把“下一步建议”作为一行注记贴进局面；只建议，不会替她出牌。',
        'x-hot': true,
      },
      'worlds.sts-2.solverTimeoutMs': {
        type: 'integer', minimum: 500, maximum: 30000, title: '求解器超时',
        description: '拿不到就当作没有这条注记，不阻塞她打牌。', 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.solverMinConfidence': {
        type: 'number', minimum: 0, maximum: 1, title: '求解器置信门槛',
        description: '低于这个置信度就不贴建议；覆盖不全或有风险时也不贴。', 'x-hot': true,
      },
      'worlds.sts-2.solverPrefetchMs': {
        type: 'integer', minimum: 0, maximum: 30000, title: '求解器建议的最小间隔',
        description: '求解器一次搜索约 0.7 秒满载 CPU；两次要建议至少隔这么久，'
          + '否则每帧一问会把游戏拖卡（真机上卡过）。观战和接管期间一律不问。',
        'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.solverAutoplay': {
        type: 'boolean', title: '战斗交给求解器打',
        description: '战斗里由桥自带的求解器一步步打完，整场不叫醒模型，只在需要决策时交回：'
          + '求解器算不出、编号对不上、血太低、要结束一回合会死的回合，或者已经离开战斗。'
          + '和「贴求解器建议」是两个开关：关掉注记也能让它代打。',
        'x-hot': true,
      },
      'worlds.sts-2.solverAutoplayMaxSteps': {
        type: 'integer', minimum: 1, maximum: 64, title: '一次接管最多几步',
        description: '超过这个步数就交回模型，防止求解器和桥互相顶着转圈。', 'x-hot': true,
      },
      'worlds.sts-2.solverAutoplayStopHpPct': {
        type: 'integer', minimum: 1, maximum: 100, title: '低于这个血量就交回',
        description: '生命百分比低于它时不再替她打，把残局交给模型。', 'x-suffix': '%', 'x-hot': true,
      },
      'worlds.sts-2.solverAutoplaySummary': {
        type: 'boolean', title: '战斗结束后说一句',
        description: '每场用求解器打完的战斗结束后发一条摘要（一条事件 = 一次模型调用）。',
        'x-hot': true,
      },
      'worlds.sts-2.observeThrottleMs': {
        type: 'integer', minimum: 0, maximum: 60000, title: '重复观察的节流',
        description: '同一局面在这个间隔内被再次观察时只回一句话，不重发状态；0 表示不节流。'
          + '要全量时用 detail:"full"，永远放行。',
        'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.exposeObserve': {
        type: 'boolean', title: '把 sts2_observe 给模型',
        description: '默认开：求解器交回、断线恢复时要靠它拿新状态码。'
          + '关掉能省调用，但模型会拿旧状态码试动作，只在确认不需要时关。', 'x-hot': false,
      },
      'worlds.sts-2.devTools': {
        type: 'boolean', title: '排障工具',
        description: '把 sts2_probe 暴露给模型；正常对局用不上，开着只会多烧 token。', 'x-hot': false,
      },
      'worlds.sts-2.batchHint': {
        type: 'boolean', title: '单步后提醒批处理',
        description: '战斗里单步 do 之后，在回执末尾提示改用 sts2_play；不改变她实际怎么打。', 'x-hot': true,
      },
      'worlds.sts-2.quietOnMenu': {
        type: 'boolean', title: '主页不替她开局',
        description: '主菜单和选角色界面不推局面、不自己点「继续上次的局」「出发」，'
          + '等玩家说了才动。关掉后她一看到主页就会自己接着打。',
        'x-hot': true,
      },
      'worlds.sts-2.queueStateEvents': {
        type: 'boolean', title: '局面等她这一轮走完再推',
        description: '她还在思考时，新到的局面先合并，等这一轮结束再一起给；减少打断和多余的模型调用。',
        'x-hot': true,
      },
      'worlds.sts-2.blockedRetryMs': {
        type: 'integer', minimum: 500, maximum: 60000, title: '卡住后的回读间隔',
        description: '判定“这一屏点不动”之后，每隔这么久自己再读一次局面；接上了就继续，不用玩家出声。',
        'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.coopRouteWaitMs': {
        type: 'integer', minimum: 0, maximum: 30000, title: '多人路线等待（0=一直等）',
        description: '多人局进地图后先压这么久再推给她，给队友投票的时间。'
          + '0 表示一直等，直到队友先投票（队友不投她就一直不点，地图会停在那儿）；'
          + '队友一投票就提前推（让她跟票，而不是当第一个点的人）；'
          + '压着的时候不催她、也不推地图，到点推的是最新投票。',
        'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.connectionQuietMs': {
        type: 'integer', minimum: 0, maximum: 120000, title: '断线多久才吭声',
        description: '事件流断开后，短于这个时长的抖动重连回来就当没发生（一次事件 = 一次模型调用）；'
          + '只有真断了这么久才说一句，接回来再说一句。',
        'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.sts-2.statePath': { type: 'string', title: '状态路径', 'x-hot': false },
      'worlds.sts-2.actionPath': { type: 'string', title: '动作路径', 'x-hot': false },
      'worlds.sts-2.eventPath': { type: 'string', title: '事件流路径', 'x-hot': false },
      'worlds.sts-2.capturePath': { type: 'string', title: '截图路径', description: '桥不支持时留空即可。', 'x-hot': false },
    },
  },
};