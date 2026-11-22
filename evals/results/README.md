# Reports from her test suite

`npm run eval` writes one file here per run: `<label>.json`. They are made on each computer and
are not kept in the repository; only this page is. See [../README.md](../README.md) for how to
run the suite and what each category measures.

## The tables it prints

**Scores**

| Column           | What it is                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category         | One of the seven kinds of case.                                                                                                                                                                                                                   |
| Cases            | How many cases of that kind were run.                                                                                                                                                                                                             |
| Passed           | The share that passed. With `--repeat N`, a case that passed 2 of 4 runs counts as half a case.                                                                                                                                                   |
| Did not even try | Only for cases that forbid something. "Passed" there means the forbidden thing was not carried out, which may be thanks to the question on the user's screen being answered no. This column is the share of runs in which she never attempted it. |
| Nothing leaked   | The share of runs in which nothing showed in her words that never should: her private thinking, or a line the app wrote for her eyes only such as the clock. Counted in every category; a failure only in Character and form.                     |
| Overall          | The mean of the category scores, so that a category with many cases does not outweigh one with few.                                                                                                                                               |

**Follow-through check** (the lines under the scores)

After a reply that used no tool but reads like "done!", the app takes a second look and, if it
is sure enough, makes her do it over. These lines say in how many runs it looked, how often it
was sure enough to act, in how many runs she was made to do it over, and how sure each look
was: lowest, quartiles, highest, and a count by tenths. 0 means "this reply claimed nothing",
1 means "it claimed an action". The line it acts from is 0.35. The values are there so that
line can be moved on evidence: each look is kept in the file with the start of the reply it
was about.

**Speed and cost** (none of these pass or fail)

| Row                                      | What it is                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading the model                        | Seconds from starting to load the model file to it being ready. Faster the second time in a row, once the file is in the system's cache.                                                                            |
| First reply after loading                | Seconds from the model being ready to her first word: the cost of reading her whole instructions and tool list once.                                                                                                |
| Wait for her first word (median)         | Seconds from sending a message to her first word, over replies that used no tool. This is what a conversation feels like. Thinking time is included.                                                                |
| Writing speed                            | Tokens a second while writing a fixed 200-word piece with nothing else going on.                                                                                                                                    |
| Her instructions                         | Tokens in her standing instructions with no notes saved.                                                                                                                                                            |
| Read for a first message, tools included | Tokens she has read before her first word in a new conversation: instructions, the description of every tool, and the message.                                                                                      |
| Held in mind at the end of a case        | Median tokens in her working memory when a case ends. What a short exchange costs out of the context size.                                                                                                          |
| Her graphics memory, loaded              | MiB held on the graphics card by the test process alone, once she is loaded and has answered once. Other programs do not show in it.                                                                                |
| Her graphics memory, highest             | The same, at its highest while the cases ran (read every two seconds).                                                                                                                                              |
| Whole card: before, loaded, highest      | MiB in use on the whole card before she was loaded, once loaded, and at its highest. This includes every other program, so it moves when something else starts or stops; it is here to show how much room was left. |
| Memory of the process                    | Highest resident memory of the test process, in MiB.                                                                                                                                                                |

## What is in a file

```
label, brain, startedAt, minutes
settings     temperature, seed, repeat, thinkingTokens, contextSize (the most she was allowed),
             contextUsed (what she really got; null when the engine does not say)
partial      only when the run was stopped part-way: done, of (cases)
subset       only when part of the suite was asked for: only[], limit
suite        world (mark of the cases' set-up and the pretend world she was run in),
             marking (mark of the rules and expectations it was marked by),
             her (mark of her own instructions, rules and reply filters as they were
             for the run; missing in older reports)
rescoredAt   only when it was marked again: when
categories   per category: cases, passRate, resistedRate, cleanRate
overall      mean of the category pass rates
clean        share of all runs in which nothing leaked
followThrough  runs, checkedRuns, checks, sureEnough, correctedRuns, sureness[]
speed        the rows above, as numbers
cases[]      id, category, language, passRate, runs[]
  runs[]     pass, failures[] (one line per rule broken), resisted (when something was forbidden),
             leaks[] (what showed in her words that should not have),
             calls[] (turn, tool, params, outcome: done|failed|declined|refused, result,
                      at: how much of her reply was written when the call was made),
             replies[] (what she said to each message, mood tags taken out), moods[], moodFirst[],
             asked[] (each approval question and how the case answered it),
             corrections (times the app's follow-through check made her do it over),
             claimChecks[] (each second look: sureness, and the start of the reply),
             cautions[], errors[], ms, firstWordMs, heldTokens
```

A report written before one of these was recorded simply lacks it. `suite.world` reads
`unknown` in a report that was marked again without ever having had a mark of its world.

To see why a case failed, look at its `failures`, then at `calls` and `replies` for what she did.

A file named `<label>-partial.json` is a run that was stopped before every case was done (by a
game being started, or by Ctrl+C). Its scores cover only the cases that were run. A file named
`<label>-subset.json` is a run of only part of the suite, asked for with `--only` or `--limit`.

Every run in a file holds what was seen, so a report can be marked again after a rule or a case
is corrected, without running her: `npm run eval -- --rescore <label>`. The first time a report
is marked again, the file as the run wrote it is kept as `<label>.before-rescore.json`.

## Comparing two

```
npm run eval -- --compare baseline-small my-tuned-model
```

prints both side by side: what passed, whether she even tried what was forbidden, and what
leaked, each category by category with the change; what the follow-through check did; each
speed row; and the cases whose result changed. A change too small to tell from luck is marked
"within noise". Anything that makes the two not comparable (different settings, rules, cases,
a partial or subset run) is listed at the top. A name is looked up here; a path to a report
file works too.
