export const QPLV = '37cd19c8-7806-4aaf-b7f5-f544899485ab'

export const reviews = [
  {
    id: 'pedido-minimo-v1',
    title: 'Confirmar el pedido mínimo antes de cotizar',
    questions: ['¿En cuánto me dejas la caja si pago de una?', '¿Me venden una cajita para probar?', '¿Con cuánto puedo arrancar?', '¿Cuál es la compra mínima para surtir mi bodega?'],
    search: 'pedido mínimo mayorista cajas distribuidor condiciones compra',
    guidance: 'Identifica con el diálogo si es compra mayorista o distribución, el producto y la cantidad. Pregunta solo los datos que faltan. Verifica el mínimo aplicable en la documentación antes de cotizar. No supongas que una caja cumple ni que pagar de una otorga descuento.',
  },
  {
    id: 'distribucion-v1',
    title: 'Reconocer consultas de distribución',
    questions: ['Tengo ruta propia, ¿cómo hago para distribuir su línea?', 'Quiero trabajar su marca en mi zona como distribuidor', '¿Qué piden para ser distribuidor autorizado?'],
    search: 'programa distribuidores requisitos vendedor distribución',
    guidance: 'Distingue reventa mayorista de distribución autorizada. Explica únicamente requisitos documentados y conserva la atención del vendedor para distribuidores.',
  },
  {
    id: 'despacho-v1',
    title: 'Verificar cobertura antes de ofrecer despacho',
    questions: ['¿Me lo arriman hasta mi negocio?', '¿Hacen despacho para mi zona?', '¿El flete va por cuenta de ustedes?'],
    search: 'despacho entrega cobertura transporte flete condiciones pedidos',
    guidance: 'Aclara la zona si falta. Confirma cobertura, flete o plazos únicamente si aparecen en la base para ese destino y tipo de compra.',
  },
] as const

export type SalesReview = typeof reviews[number]
export type Decision = 'approved' | 'rejected'
export function normalizeQuestion(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function matchReview(question: string) {
  const normalized = normalizeQuestion(question)
  return reviews.find(r => r.questions.some(q => normalizeQuestion(q) === normalized))
}

export const commercialPolicy = 'En consultas de precio de QPLV usa la base comercial vigente. Distingue mayoristas y distribuidores. Para cotizar confirma producto, cantidad y canal, y verifica el mínimo aplicable. Si faltan datos, pregúntalos. Si falta respaldo documental, no indiques montos, descuentos ni mínimos. Pagar de una no demuestra elegibilidad para un descuento.'

