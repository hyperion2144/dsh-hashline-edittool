# new-F3-elide-drop-nested-order

> 作答代理只看 `arms/new-F3-elide-drop-nested-order.txt`。

Q1: src/ast/elide.ts 的 dropNested(spans: readonly ElisionSpan[]): ElisionSpan[]（hunk @@ -149,7 +149,7 @@ dropNested()），改动落在函数内构造 sorted 的那一行 sort 比较器。
Q2: 同一起始行的次级排序键由 endLine 降序（`b.endLine - a.endLine`，长 span 排前）改为升序（`a.endLine - b.endLine`，短 span 排前）；即同起点 span 的处理顺序从「最长优先」变为「最短优先」，起始行不同的 span 之间排序结果不变。
Q3: 仅当比较器第一项 `a.startLine - b.startLine === 0`（两个 span 起始行相同）时该改动才影响顺序；没有同起点 span 的输入，第二项不参与任何比较。
Q4: 方向：只影响「同 startLine」这一分支——起始行互不相同的输入下排序序列与改前逐位相同，函数输出等价。输入含同起点 span 时，`sorted` 中它们的相对顺序对调，后续 `for (const span of sorted)` 循环（涉及 `out` 与 `coveredTo`，但循环体不在 diff 内）的保留/剔除结果可能随之改变，具体是否翻转从 diff 看不出来；不产生同起点 span 的外部调用者不受影响。
SELF: 3（Q1–Q3 可确定；Q4 只能确定到「仅同起点分支受影响」，同起点时结果是否变化看不出来）
