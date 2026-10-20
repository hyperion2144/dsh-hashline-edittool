# new-F1-myers-tiebreak

> 作答代理只看 `arms/new-F1-myers-tiebreak.txt`。

Q1: src/render/line-diff.ts 的 myersRange() 函数（前向 Myers 循环内、对角线 k 的分支选择处，约 194–201 行）。
Q2: 平局裁决翻转：改前当 v[mid+k-1] 与 v[mid+k+1] 相等时走 else，x = v[mid+k-1]+1（从 k-1 右移，先消耗序列 a 的一行）；`<` 改 `<=` 后平局改走 x = v[mid+k+1]（从 k+1 下移，先消耗序列 b 的一行）——即编辑距离 d 不变，但在同样最小的多个编辑脚本里改选了另一条路径，行的删除/插入配对分组可能随之改变。
Q3: 仅当 k ≠ -d 且 k ≠ d（内部对角线）且 v[mid+k-1] === v[mid+k+1] 严格相等时生效；严格小于/大于及 k=±d 边界分支行为与改前一致。
Q4: 只影响该平局分支（函数内其余分支与编辑距离不变），但对含平局的输入，产出的 trace/diff 内容可能与改前不同且仍同为最小脚本；myersRange 的外部调用方在 diff 里看不到，进一步影响从 diff 看不出来。
SELF: 4
