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
  const price = property.Rent_QAR ? property.Rent_QAR + ' QAR/month' : 'Please enquire';
  const size = property.Size_sqm ? property.Size_sqm + ' sqm' : '';
  const beds = property.Bedrooms ? property.Bedrooms + ' BR' : '';
  const baths = property.Bathrooms ? property.Bathrooms + ' BA' : '';
  const location = property.Location || 'Doha, Qatar';
  const mapLink = property.Maps_Link ? '\n' + property.Maps_Link : '';

  const details = [size, beds, baths].filter(Boolean).join(' | ');

  return `${typeAr} for rent | ${property.Type} For Rent
${location}
${price}${details ? '\n' + details : ''}
---
Contact us:
Mohammed: 31293905
Nizar: 77851855
Ahmed: 55513389

WhatsApp: +974 7029 7066
Al-Imtiaz Property Management${mapLink}`;
}

module.exports = { buildTitleAr, buildTitleEn, buildDescription };
