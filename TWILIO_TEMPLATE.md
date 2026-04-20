# Twilio Content Template — Monthly Vacancy Broadcast

Paste the body below into **Twilio Console → Messaging → Content Template Builder**, then submit for Meta/WhatsApp approval.

---

## Template Settings

| Field | Value |
|---|---|
| **Friendly name** | `monthly_vacancy_broadcast` |
| **Language** | `ar` (Arabic — primary) |
| **Category** | `MARKETING` |
| **Content type** | `twilio/text` (or `twilio/media` if you later add a header image) |
| **Variables** | `{{1}}` — carries the dynamic unit list |

---

## Template Body (copy exactly)

```
*Properties for rent | عقارات للايجار*

السلام عليكم،
تتوفر لدينا الوحدات التالية للإيجار:

Dear Sir/Madam,
The following units are available for rent:

{{1}}

Contact | للتواصل:
Mohamed Zaidan: 3129 3905
Nizar: 7785 1855
Ahmed: +974 5551 3389

📱 بوت واتساب متاح ٢٤/٧ | WhatsApp Bot Available 24/7
للاستفسار الفوري عن العقارات، تحدث مع مساعدنا الذكي على واتساب
For instant property inquiries, chat with our AI assistant on WhatsApp
+974 7029 7066
أرسل لنا رسالة في أي وقت — نرد بالعربية والإنجليزية فوراً ✓
Send us a message anytime — we reply in Arabic & English instantly ✓
```

---

## Sample value for `{{1}}` (required by Meta for review)

Use this exact sample when Twilio asks for the `{{1}}` sample — it proves to the Meta reviewer what the variable will contain:

```
1- P6A Warehouse (Industrial Area)
   Size: 500 sqm
   Rent: 25,000 QAR/month

2- P26 Workers Accommodation (Industrial Area)
   Rooms: 40
   Rent: 3,500 QAR/room/month

3- P48 Al Sadd Building (Al Sadd)
   2 BHK Apartment
   Rent: 7,500 QAR/month

4- P49 Al Sadd Room (Al Sadd)
   Studio / Single Room
   Rent: 2,200 QAR/month
```

---

## After Meta approves the template

1. Open the template in Twilio Console → copy the **Content SID** (starts with `HX…`).
2. On Railway, set:
   ```
   TWILIO_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
3. Also confirm these Railway env vars are set:
   ```
   TWILIO_WHATSAPP_NUMBER=whatsapp:+15559313545   (your production sender)
   BROKERS_SHEET_ID=<id of the new Brokers Google Sheet>
   ```
4. Test safely before the 1st of next month:
   ```
   POST /broadcast-brokers   { "dryRun": true }
   POST /broadcast-brokers   { "testOnly": true }   // sends only to your own number
   ```

---

## Notes

- The **static text** (header, greeting, contacts, bot footer) lives inside the approved template — Meta locks this down.
- Only the **`{{1}}` variable** changes each month — it receives the vacant-unit list produced by `vacancy-from-pdf.js` (pulled from the monthly PDF rent report via Gmail + Claude Vision, same logic as your Apps Script).
- Emojis, asterisks for bold, and Arabic text are all allowed in WhatsApp Business templates.
- Category must be **MARKETING** (not Utility/Authentication) because this is a promotional broadcast to brokers.
