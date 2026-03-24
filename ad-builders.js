/**
 * ad-builders.js – Shared bilingual ad content builders
 * Used by poster.js, qatarsale.js, and mzad.js
 */

const TYPE_AR = {
  'Villa': 'فيلا',
  'Apartment': 'شقة',
  'Warehouse': 'مخزن',
  'Shop': 'محل تجاري',
  'Labor Camp': 'سكن عمال',
  'Factory': 'مصنع',
  'Building': 'عمارة',
  'Room': 'غرفة',
  'Grocery': 'بقالة',
  'Commercial': 'عقار تجاري',
};

function buildTitleAr(property) {
  const type = TYPE_AR[property.Type] || property.Type;
  return `${type} للإيجار - ${property.Location || 'الدوحة'} - قطر`;
}

function buildTitleEn(property) {
  return `${property.Type} For Rent - ${property.Location || 'Doha'} - Qatar`;
}

function buildDescription(property) {
  const typeAr = TYPE_AR[property.Type] || property.Type;

  const price = property.Rent_QAR
    ? `${property.Rent_QAR} ريال/شهر | QAR ${property.Rent_QAR}/month`
    : 'يرجى الاستفسار | Please enquire';

  const size = property.Size_sqm
    ? `${property.Size_sqm} م² | ${property.Size_sqm} sqm`
    : 'يرجى الاستفسار | Please enquire';

  const beds = property.Bedrooms || 'يرجى الاستفسار | Please enquire';
  const baths = property.Bathrooms || 'يرجى الاستفسار | Please enquire';
  const floor = property.Floor || 'يرجى الاستفسار | Please enquire';
  const location = property.Location || 'الدوحة، قطر | Doha, Qatar';
  const notes = property.Notes ? `\n• المنطقة | Zone: ${property.Notes}` : '';
  const mapLink = property.Maps_Link ? `\n📍 الموقع | Location: ${property.Maps_Link}` : '';

  return `🏢 ${typeAr} للإيجار | ${property.Type} For Rent
━━━━━━━━━━━━━━━━━━━━━━━━━

📋 تفاصيل العقار | Property Details:
- النوع | Type: ${typeAr} | ${property.Type}
- الموقع | Location: ${location}${notes}
- الإيجار | Rent: ${price}
- المساحة | Size: ${size}
- الطابق | Floor: ${floor}
- غرف النوم | Bedrooms: ${beds}
- دورات المياه | Bathrooms: ${baths}${mapLink}

━━━━━━━━━━━━━━━━━━━━━━━━━
تمام! بإمكانك التواصل مع أحد ممثلينا مباشرة:
You may contact us on the below number

للتنسيق والاستفسار يرجى التواصل مع أحد ممثلينا:
👤 محمد زيدان: 31293905 Mohammed
👤 نزار: 77851855 Nizar
👤 أحمد: 55513389 Ahmed

بإمكانهم ترتيب مواعيد المعاينة والإجابة على جميع استفساراتك حول العقارات المتاحة.
Available 24/7

للاستفسار الفوري عن العقارات، تحدث مع مساعدنا الذكي على واتساب
For instant property inquiries, chat with our AI assistant on WhatsApp
+974 7029 7066
أرسل لنا رسالة في أي وقت — نرد بالعربية والإنجليزية فوراً ✓
Send us a message anytime — we reply in Arabic & English instantly ✓

🏢 الامتياز والجودة لإدارة العقارات
Al-Imtiaz Wal-Jawada Property Management`;
}

module.exports = { buildTitleAr, buildTitleEn, buildDescription };
