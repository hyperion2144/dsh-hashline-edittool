# old-F5-align-dp-budget-edge

> 作答代理只看 `arms/old-F5-align-dp-budget-edge.txt`。

Q1: diff 里没有文件路径与函数名，只能看出改动落在「对裁剪后的 oldSeg/newSeg 调用 lcsBacktrace 做全量 DP 对齐」的函数中、控制是否跑该 DP 的 if 判断处；具体文件与函数名从 diff 看不出来。
Q2: 语义变化：全量 DP 的准入条件从 `mMid * nMid <= effective`（DP 表字节数 8·m·n 不超过预算即跑）收紧为严格小于；在恰好等于预算的边界上，改前会运行全量 DP 求最优对齐，改后改走 else 的非全量路径（该路径具体做什么 diff 里看不到）。
Q3: 生效条件是可判定的等值分支 `mMid * nMid === effective`：乘积严格小于或严格大于 effective 时两版本行为完全相同，仅当 DP 表字节数恰好等于预算时行为翻转。
Q4: 方向：只影响这一个等值边界分支，函数内其余分支（小于跑 DP、大于走 else）行为不变；外部调用者是否受影响取决于是否存在 mMid*nMid 恰好等于 effective 的输入组合，依据是两侧比较结果未变，调用者情况从 diff 看不出来。
SELF: 3（Q2/Q3/Q4 的方向可确定作答；Q1 的文件与函数名 diff 未给出，Q4 中调用者层面的影响无法判定）
