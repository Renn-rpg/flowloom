// 副作用模块：加载 .env（全局 ~/.floom/.env 优先，项目级 $CWD/.env 覆盖）。
//
// 必须作为 cli 入口的**第一个 import**。原因：ESM 会把所有 import 提升、按源码顺序先求值，
// 再跑模块体代码。若像以前那样在 cli.ts 模块体里调 dotenv config()，它会**晚于**所有 import——
// 包括 session-factory 这种在 import 期就求值环境常量（CONTEXT_TOKENS / MAX_TOKENS / REASONER_MODEL）
// 的模块 → 这些常量读不到 .env，导致「用 .env 覆盖它们不生效」。
// 把加载放进这个最先被 import 的副作用模块，即可保证 .env 在任何环境常量求值前就位。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config } from 'dotenv'

config({ path: join(homedir(), '.floom', '.env'), quiet: true })
config({ quiet: true }) // $CWD/.env 覆盖全局
