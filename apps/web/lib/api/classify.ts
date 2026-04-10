import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

// Swedish expenditure areas (utgiftsområden) — static reference
const EXPENDITURE_AREAS: Record<string, string> = {
  '01': 'Rikets styrelse',
  '02': 'Samhällsekonomi och finansförvaltning',
  '03': 'Skatt, tull och exekution',
  '04': 'Rättsväsendet',
  '05': 'Internationell samverkan',
  '06': 'Försvar och samhällets krisberedskap',
  '07': 'Internationellt bistånd',
  '08': 'Migration',
  '09': 'Hälsovård, sjukvård och social omsorg',
  '10': 'Ekonomisk trygghet vid sjukdom och funktionsnedsättning',
  '11': 'Ekonomisk trygghet vid ålderdom',
  '12': 'Ekonomisk trygghet för familjer och barn',
  '13': 'Jämställdhet och nyanlända invandrares etablering',
  '14': 'Arbetsmarknad och arbetsliv',
  '15': 'Studiestöd',
  '16': 'Utbildning och universitetsforskning',
  '17': 'Kultur, medier, trossamfund och fritid',
  '18': 'Samhällsplanering, bostadsförsörjning och byggande',
  '19': 'Regional utveckling',
  '20': 'Klimat, miljö och natur',
  '21': 'Energi',
  '22': 'Kommunikationer',
  '23': 'Areella näringar, landsbygd och livsmedel',
  '24': 'Näringsliv',
  '25': 'Allmänna bidrag till kommuner',
  '26': 'Statsskuldsräntor m.m.',
  '27': 'Avgiften till Europeiska unionen',
}

export async function classifyTopic(topic: string): Promise<string[]> {
  const areaList = Object.entries(EXPENDITURE_AREAS)
    .map(([code, name]) => `${code}: ${name}`)
    .join('\n')

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      messages: [
        {
          role: 'user',
          content: `Givet ämnet "${topic}", vilka av följande svenska utgiftsområden är mest relevanta?
Svara med en JSON-array av exakt 1-3 kodsträngar, t.ex. ["16","20"]. Inget annat.

${areaList}`,
        },
      ],
    })

    const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '[]'
    const codes = JSON.parse(text) as string[]
    // Validate all returned codes exist
    return codes.filter(c => EXPENDITURE_AREAS[c])
  } catch (e) {
    console.error('[classify] topic classification failed, budget layer will be skipped', e)
    return []
  }
}
