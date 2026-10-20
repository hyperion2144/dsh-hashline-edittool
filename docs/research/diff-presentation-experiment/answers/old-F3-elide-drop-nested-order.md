# old-F3-elide-drop-nested-order

> 作答代理只看 `arms/old-F3-elide-drop-nested-order.txt`。

Q1: 从 diff 看不出所属文件（该 diff 无文件头），只能确定函数：dropNested(spans: readonly ElisionSpan[]): ElisionSpan[]，其上方注释为「Remove spans fully contained in another; the outer fold already covers them.」。
Q2: 改的是排序比较器的并列分支：改前 `[...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)` 在 startLine 相同时 endLine 降序（更长/更外层的 span 排前面）；改后为 `a.endLine - b.endLine` 升序（更短的 span 排前面）。语义差异：同一起始行的多个 span，嵌套去重扫描（out/coveredTo/for 循环）的处理顺序由「最长优先」变为「最短优先」，从而决定哪个 span 先进入结果、哪些被当作已被覆盖丢弃——改后与注释「外层 fold 已覆盖内层」的意图相悖（循环体在 diff 中未展示，具体哪个被丢无法进一步判定）。
Q3: 仅当两个 span 的 startLine 相等（即 `a.startLine - b.startLine === 0`，比较器退化到第二个表达式）时改动才生效；startLine 不同的 span 之间排序与改前完全一致。
Q4: 方向——只影响 dropNested 内部对「相同 startLine 的 span」的排序，进而只在这类输入下可能改变该函数的输出（保留哪个 span 或输出顺序）；对不含相同 startLine 的输入行为等价（比较器首个非零项不变）。对外部调用者的影响从 diff 看不出来（diff 未包含调用点），但任何传入含同 startLine span 的调用者可能拿到不同结果。
SELF: 4（第 1 问只能确定到函数级，所属文件名 diff 里没有，已如实标注）
