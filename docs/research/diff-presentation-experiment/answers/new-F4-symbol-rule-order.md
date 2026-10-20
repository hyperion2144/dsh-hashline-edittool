# new-F4-symbol-rule-order

> 作答代理只看 `arms/new-F4-symbol-rule-order.txt`。

Q1: `src/ast/symbols.ts` 的顶层函数 `ruleMatches(rule: KindRule, node: Node): boolean`（hunk `@@ -258,12 +258,12 @@ ruleMatches()`）。
Q2: 语义变化是六个卫语句的**求值顺序**变了：`if (rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)) return false;` 从函数末尾（`return true` 之前最后一个检查）移到函数第一行；由于全部条件是相互独立的「与」守卫（任一不满足即 `return false`，全过才 `return true`），布尔结果不变，只是对同时违反多个条件的规则，现在最先因 `childAbsent` 短路返回，`hasChildOfType` 等谓词的执行先后随之改变。
Q3: 生效分支就是被移动的那个条件本身：当 `rule.childAbsent !== undefined` 且 `hasChildOfType(node, rule.childAbsent)` 为真时，函数现在在检查 `parentType`/`ancestorType`/`ancestorAbsent`/`childType`/`childText` 之前就返回 `false`；其余条件（含 `rule.childAbsent === undefined` 的规则）逐行字节内容不变。
Q4: 方向：**行为等价**（就返回值而言）——diff 中六条条件逐字节相同、仅顺序调整（行数 12→12 不变），「与」守卫可交换，故各分支最终真值不变、外部调用者的判定结果不受影响；唯一不可从 diff 判定的是各 `hasXxx` 谓词是否有副作用/性能差异（看不到其实现），若为纯谓词则完全等价。
SELF: 4
