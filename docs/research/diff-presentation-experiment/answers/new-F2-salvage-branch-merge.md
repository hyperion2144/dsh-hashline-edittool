# new-F2-salvage-branch-merge

> 作答代理只看 `arms/new-F2-salvage-branch-merge.txt`。

Q1: src/hashline/anchor-pipeline.ts 的 salvageAnchorRef()（hunk @@ -550,10 +550,9 @@，错误消息拼装处）。
Q2: 改前是两条独立 else if（match[1] === "+" 时输出 "stripped diff-preview \"+\" marker…"，match[1] === "-" 时输出 "stripped leading \"-\" marker…"）；改后合并为一条 `match[1] === "+" || match[1] === "-"` 分支，用 `const which = match[1] === "+" ? `diff-preview "+"` : `leading "-"` 插值生成同一模板。两种取值拼出的字符串与原消息逐字相同，所以是纯结构合并（去重消息模板），无行为差异。
Q3: 生效条件：`rest` 非多行（首个 `/\r\n?|\n/.test(rest)` 分支未命中）且 ref 首个匹配字符 match[1] 是 "+"（diff 预览行被剥掉 "+" 前缀）或 "-"（被剥掉行首 "-" 前缀）；两者都仍发出同一条 E_BAD_REF。其余输入走末尾 else（仅剥尾随内容）。
Q4: 行为等价。依据：合并分支的 `which` 插值在两种取值下产生与原两条消息逐字一致的文本；多行分支与末尾 else 分支的上下文行未动；净变化仅 -1 行且全部落在这条 else-if 链内。调用者可见的只有相同的 E_BAD_REF 消息文本——函数外影响从 diff 看不出来，但按消息逐字等价判断无外部可见变化。
SELF: 4
