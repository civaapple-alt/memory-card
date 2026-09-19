/**
 * 释义正文块。取词页与复习页共用，保证两处显示顺序与取舍完全一致。
 *
 * 顺序（计划 反馈 4 / D2）：场景概要 → 语境（在这句话里 / 原文）→ 例句 / 搭配 → 通用含义（弱化收尾）。
 * 注意：`why_translation_fails` 已按 D2 从默认展示中移除，但数据仍保留在库里，不删字段。
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

      {inContext && (
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
