# old-F2-salvage-branch-merge

> 作答代理只看 `arms/old-F2-salvage-branch-merge.txt`。

Q1: 文件名与函数名在 diff 中均未出现，看不出；只能定位到「构造 [E_BAD_REF] 解析错误消息」的 if/else-if 分支链——位于多行块检测分支之后、兜底 "stripped trailing content" 分支之前的 marker 处理分支（周围可见 anchor、match、rest、fieldLabel、clipLine 等变量）。
Q2: 改前是两个独立 else-if：`match[1] === "+"` 输出 "stripped diff-preview \"+\" marker and trailing content…"，`match[1] === "-"` 输出 "stripped leading \"-\" marker and trailing content…"；改后合并为一个 `match[1] === "+" || match[1] === "-"` 分支，先由三元 `which` 选出对应短语（"+"→`diff-preview "+"`，"-"→`leading "-"`）再插入同一消息模板。两种输入各自生成的消息文本与改前逐字相同，语义上是纯去重合并，无输出差异。
Q3: 生效条件：前置多行检测 `/\r\n?|\n/.test(rest)` 为假，且解析匹配到的 `match[1]`（第二捕获组）等于 "+" 或 "-"——对这两个字面值的相等比较，任一命中即走合并分支，which 取值由 `match[1] === "+"` 决定。
Q4: 行为等价、不波及其他分支：合并分支用 which 三元复现了被删两分支的逐字消息文本；多行块分支与最后的 else（stripped trailing content）都是未改动的上下文行；错误码 E_BAD_REF 与消息串不变，故对调用者可见行为不变。依据是 diff 中新模板 + 三元与被删分支文本逐字对照一致、上下文行未动。
SELF: 3（Q1 的文件名/函数名从 diff 看不出来，其余三题可确定作答）
