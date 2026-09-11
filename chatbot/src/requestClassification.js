'use strict';

// Deterministic classification for requests whose semantics are known before
// planning. These guards prevent a model from turning an invalid step-count
// request into a questionnaire, and prevent a contradiction from being reported
// as an unsupported capability.

function classifySpecialRequest(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return null;

  const arbitraryStepCount = /^(?:改(?:成|為|为)|變成|变成|設定為|设为)\s*\d+\s*步[。．.!！]?$/i.test(text)
    || /^(?:change|set|make)\s+(?:it|the\s+plan)?\s*(?:to\s+)?\d+\s+steps?[.!]?$/i.test(text);
  if (arbitraryStepCount) {
    return {
      outcome: 'unsupported_capability',
      detailZh: '系統不會為了湊步驟數加入沒有意義的 no-op 步驟。',
      detailEn: 'The service does not add meaningless no-op steps just to reach a requested count.',
    };
  }

  const contradictoryChinese = /(?:抓|取得|获取|擷取|擷取到).{0,30}todos.{0,40}(?:不要|不能|不可以).{0,20}(?:網路|网络|HTTP|請求|请求)/i.test(text)
    || /(?:不要|不能|不可以).{0,20}(?:網路|网络|HTTP|請求|请求).{0,30}(?:抓|取得|获取|擷取).{0,20}todos/i.test(text);
  const contradictoryEnglish = /(?:fetch|get|retrieve).{0,30}\btodos?\b.{0,40}(?:without|no|don't|do not).{0,20}(?:network|http|request)/i.test(text)
    || /(?:without|no|don't|do not).{0,20}(?:network|http|request).{0,30}(?:fetch|get|retrieve).{0,20}\btodos?\b/i.test(text);
  if (contradictoryChinese || contradictoryEnglish) {
    return {
      outcome: 'clarification_required',
      detailZh: '取得 todos 需要發出公開 HTTP 請求；請確認是否允許使用支援的公開資料來源。',
      detailEn: 'Fetching todos requires a public HTTP request; please confirm whether the supported public data source is allowed.',
    };
  }

  return null;
}

module.exports = { classifySpecialRequest };
