# old-F4-symbol-rule-order

> 作答代理只看 `arms/old-F4-symbol-rule-order.txt`。

Q1: 改动落在 `ruleMatches(rule: KindRule, node: Node): boolean` 函数体内（其早退 guard 序列中间）；diff 无文件头，所在文件名从 diff 看不出来。
Q2: 语义变化是把 `childAbsent` 检查从 guard 序列的**最后一位**（childText 之后、`return true` 之前）移到**第一位**（parentType 之前）。由于六个 guard 都是独立的 `if (条件) return false` 合取式早退，对任意 (rule, node) 的最终返回值不变；变的是短路求值顺序——改前要先通过 parentType/ancestorType/ancestorAbsent/childType/childText 全部检查才会轮到 childAbsent 拒绝，改后带 childAbsent 且不满足的 rule 立即被拒，其余条件不再求值。
Q3: 改动本身无条件生效（对 ruleMatches 的每次调用都按新顺序执行）；被移动分支的触发条件是 `rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)` 为真（规则声明了必须不存在的子节点类型，而节点实际含有该类型子节点）→ 返回 false，改后此判定先于 parentType 判定短路。
Q4: 返回值层面行为等价（依据：各 guard 互相独立且都返回 false，换序不改变合取结果，被移动行文本逐字相同）；可观察差异仅限失败时先命中的条件/求值顺序——仅当 hasChildOfType 等辅助函数有副作用、或调用方区分失败原因时才会外显，这从 diff 看不出来；函数内其余分支（parentType→childText）判定内容未变，只是不再先于 childAbsent 执行；外部调用者清单 diff 里看不到。
SELF: 4（Q1 仅能确定到函数级，文件名从 diff 看不出来）
