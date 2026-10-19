import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSIFICATION_RULES, csvCell, suggest } from './team-classification-rules';

test('suggests only from multiple literal stem signals inside the documentary course', () => {
  const stem = 'Uma pessoa com diabetes apresenta hipoglicemia após uso de insulina.';
  const draft = suggest('medicine', stem);
  assert.equal(draft.outcome, 'suggested');
  assert.equal(draft.suggestion?.proposedTopic, 'Diabetes mellitus');
  assert.equal(draft.suggestion?.evidence.length, 2);
  for (const e of draft.suggestion!.evidence) assert.equal(stem.slice(e.start, e.end), e.text);
  assert.equal(suggest('physical_education', stem).outcome, 'abstained');
});
test('abstains rather than fabricate a topic from a single diagnosis word or absent course', () => {
  assert.equal(suggest('medicine', 'Qual a definição de diabetes?').outcome, 'abstained');
  assert.equal(suggest('unknown', 'Diabetes e glicemia.').outcome, 'abstained');
  assert.equal(suggest('medicine', '').outcome, 'abstained');
});
test('tied topics remain conflicts for human triage', () => {
  const draft = suggest('medicine', 'Diabetes e glicemia, asma e broncodilatador.');
  assert.equal(draft.outcome, 'conflict');
  assert.equal(draft.suggestion, null);
  assert.equal(draft.candidates.length, 2);
});
test('each of the ten courses has explicit proposed rules, IDs are unique and patterns valid', () => {
  assert.equal(new Set(CLASSIFICATION_RULES.map(row => row.course)).size, 10);
  assert.equal(new Set(CLASSIFICATION_RULES.map(row => row.id)).size, CLASSIFICATION_RULES.length);
  for (const rule of CLASSIFICATION_RULES) {
    assert.ok(rule.area.length > 0 && rule.topic.length > 0);
    assert.ok(rule.patterns.length >= 2);
    for (const pattern of rule.patterns) assert.doesNotThrow(() => new RegExp(pattern, 'iu'));
  }
});
test('does not identify cão inside educação', () => {
  assert.equal(suggest('veterinary_medicine', 'Educação sobre a cinomose.').outcome, 'abstained');
});
test('escapes spreadsheet formulas including whitespace, tabs and BOM', () => {
  for (const text of ['=IMPORTXML("url")', '+1', '-1', '@SUM(A1)', ' \t=1+1', '\uFEFF=1']) assert.ok(csvCell(text).startsWith('"\''));
  assert.equal(csvCell('Conteúdo, "original"\nlinha'), '"Conteúdo, ""original""\nlinha"');
  assert.equal(csvCell(null), '""');
});
test('is deterministic and never asserts a reviewed taxonomy or difficulty', () => {
  const text = 'Prescrição de exercício: intensidade e duração.';
  const a = suggest('physical_education', text);
  assert.deepEqual(a, suggest('physical_education', text));
  assert.equal(a.outcome, 'suggested');
  assert.equal('areaId' in a, false);
  assert.equal('topicId' in a, false);
  assert.equal('difficulty' in a, false);
  assert.equal('correctKey' in a, false);
});
test('word boundary patterns match acronyms and reject surrounding-word substrings', () => {
  const examples = [
    ['medicine', 'SUS universalidade'], ['medicine', 'HIV antirretroviral'],
    ['medicine', 'aids CD4'], ['medicine', 'AVC hemiparesia'], ['medicine', 'asma broncodilatador'],
    ['psychology', 'TCC crenças'], ['psychology', 'CAPS reforma psiquiátrica'],
    ['physiotherapy', 'DPOC exercício'], ['physiotherapy', 'AVC reabilitação'],
    ['biomedicine', 'PCR DNA'], ['nutrition', 'antropometria IMC'],
    ['veterinary_medicine', 'cão cinomose'], ['veterinary_medicine', 'gato esporotricose'],
  ];
  for (const [course, stem] of examples) {
    assert.equal(suggest(course!, stem!).outcome, 'suggested', `${course}: ${stem}`);
  }
  assert.equal(suggest('medicine', 'XSUSX universalidade').outcome, 'abstained');
  assert.equal(suggest('medicine', 'XHIVX antirretroviral').outcome, 'abstained');
  assert.equal(suggest('biomedicine', 'XPCRX DNA').outcome, 'abstained');
  for (const rule of CLASSIFICATION_RULES)
    for (const pattern of rule.patterns) assert.equal(pattern.includes('\\\\b'), false, rule.id);
});
