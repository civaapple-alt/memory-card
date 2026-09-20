/**
 * 释义正文块。取词页与复习页共用，保证两处显示顺序与取舍完全一致。
 *
 * 顺序（计划 反馈 4 / D2）：场景概要 → 语境（在这句话里 / 原文）→ 例句 / 搭配 → 通用含义（弱化收尾）。
 * 注意：`why_translation_fails` 已按 D2 从默认展示中移除，但数据仍保留在库里，不删字段。
 *
 * 「在这句话里」必须挂在 `sentence` 上（计划：词和句子拆成两个输入框）：
 * 模型无论有没有上下文都会填 `in_context`，无句子时它填的是领域知识 ——
 * 和上面的 hero 段讲的是同一件事，挂个"这句话"的标签只会让人以为系统读了某句话。
 */
export function DefinitionBody({
  domainMeaning,
  inContext,
  sentence,
  examples = [],
  collocations = [],
  general,
}: {
  domainMeaning: string;
  inContext?: string | null;
  sentence?: string | null;
  examples?: string[];
  collocations?: string[];
  general?: string | null;
}) {
  return (
    <>
      <div className="meaning">{domainMeaning || "（模型没给出领域释义）"}</div>

      {sentence && inContext && (
        <div className="block">
          <div className="block-label">在这句话里</div>
          <div>{inContext}</div>
        </div>
      )}

      {sentence && (
        <div className="block">
          <div className="block-label">原文</div>
          <div className="quote">{sentence}</div>
        </div>
      )}

      {examples.length > 0 && (
        <div className="block">
          <div className="block-label">例句</div>
          <ul className="examples">
            {examples.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}

      {collocations.length > 0 && (
        <div className="block">
          <div className="block-label">常见搭配</div>
          <div className="chips">
            {collocations.map((c, i) => (
              <span className="chip" key={i}>
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {general && (
        <div className="block dim">
          <div className="block-label">通用含义</div>
          <div>{general}</div>
        </div>
      )}
    </>
  );
}
