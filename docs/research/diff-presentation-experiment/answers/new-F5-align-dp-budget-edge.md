# new-F5-align-dp-budget-edge

> 作答代理只看 `arms/new-F5-align-dp-budget-edge.txt`。

Q1: 改动落在 src/hashline/align-bounded.ts 的 alignPreservedBounded() 函数（hunk @@ -171,7 +171,7 @@），即预算判断那一行 if 条件。
Q2: 语义变化：原 `if (mMid * nMid <= effective)` 允许「DP 表大小恰好等于预算」时走完整 DP 分支；改成 `<` 后，恰好相等的情况被划为超预算，改走另一分支（fallback/有界对齐路径）。即满预算从「允许完整 DP」变为「不允许」，判定边界从闭区间变为开区间。
Q3: 生效条件可判定：仅当 `mMid * nMid == effective`（严格相等）时行为改变；`<` 时两版都走完整 DP，`>` 时两版都走 else 分支。注释「Below the threshold, run the full DP」与新写法（严格小于）语义一致。
Q4: 影响方向：只影响恰好等于预算这一边界分支，其余输入（严格小于/大于）行为等价，因为两版条件仅在相等点不同；对调用者而言，`alignPreservedBounded()` 在相等场景下的返回结果可能改变，但 else 分支具体做什么、调用者是谁，从 diff 看不出来。
SELF: 4（四题都能从 diff 里确定地答出，Q4 的 else 分支内容/调用者除外，已注明「看不出来」）
