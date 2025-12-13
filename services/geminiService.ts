import { GoogleGenAI, Type, GenerateContentResponse, Part } from "@google/genai";
import { ExtractedData } from '../types';

const dataExtractionSchema = {
  type: Type.OBJECT,
  properties: {
    beneficiaryName: { type: Type.STRING, description: 'اسم المستفيد الكامل' },
    accountNumber: { type: Type.STRING, description: 'رقم حساب المستفيد (IBAN إن وجد)' },
    swiftCode: { type: Type.STRING, description: 'رمز سويفت الخاص بالبنك (SWIFT/BIC)' },
    bankName: { type: Type.STRING, description: 'اسم البنك' },
    country: { type: Type.STRING, description: 'الدولة' },
    city: { type: Type.STRING, description: 'المدينة' },
    province: { type: Type.STRING, description: 'المقاطعة أو الولاية' },
    address: { type: Type.STRING, description: 'العنوان الكامل' },
    goodsDescription: { type: Type.STRING, description: 'وصف موجز للبضائع أو الخدمات المذكورة في المستند، مثل الفواتير أو بوليصات الشحن.' },
  },
  required: ['beneficiaryName', 'accountNumber', 'swiftCode', 'bankName', 'country']
};

export const extractDataFromFile = async (contentPart: Part): Promise<ExtractedData> => {
  // Always create a new instance to ensure the latest API key from the environment is used
  const aiClient = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = `
    أنت خبير متخصص في استخراج البيانات المالية.
    حلل المحتوى واستخرج البيانات المصرفية بدقة عالية.
    ابحث باللغتين العربية والإنجليزية.
    اترك الحقل فارغاً إذا لم تتوفر المعلومة.
  `;
  
  const response = await aiClient.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: { parts: [contentPart, { text: prompt }] },
    config: {
      responseMimeType: 'application/json',
      responseSchema: dataExtractionSchema,
    },
  });

  // Use optional chaining with nullish coalescing for robustness
  const jsonText = response.text?.trim() ?? '';
  if (!jsonText) {
    throw new Error("فشل في استخراج البيانات: استجابة فارغة أو غير صالحة من النموذج.");
  }

  try {
    const data = JSON.parse(jsonText) as ExtractedData;

    // تطبيق قواعد التنسيق المطلوبة (Capitalization)
    if (data.beneficiaryName) {
      // Format beneficiaryName: remove special characters, keep letters, numbers, and spaces
      // Use \p{L} for Unicode letters and \s for whitespace
      data.beneficiaryName = data.beneficiaryName.replace(/[^0-9\p{L}\s]/gu, '').toUpperCase();
    }

    // تنسيق رقم الحساب: إزالة المسافات والفواصل والشرطات
    if (data.accountNumber) {
      data.accountNumber = data.accountNumber.replace(/[\s\-\_]/g, '');
    }

    if (data.country) data.country = data.country.toUpperCase();
    if (data.province) data.province = data.province.toUpperCase();
    if (data.city) data.city = data.city.toUpperCase();
    if (data.address) data.address = data.address.toUpperCase();

    // معالجة رمز السويفت (SWIFT Code Logic)
    if (data.swiftCode) {
      let code = data.swiftCode.trim().toUpperCase();
      // إذا كان طول الرمز 8 خانات، نضيف XXX
      if (code.length === 8) {
        code += 'XXX';
      }
      data.swiftCode = code;
    }

    return data;
  } catch (e) {
    console.error("Failed to parse JSON from Gemini:", jsonText);
    throw new Error("فشل في تحليل البيانات المستخرجة: تنسيق استجابة غير متوقع من النموذج.");
  }
};

export const getCompanyInfo = async (companyName: string, bankName: string, goodsDescription?: string): Promise<{ info: string; sources: { uri: string; title: string }[] }> => {
  const aiClient = new GoogleGenAI({ apiKey: process.env.API_KEY });

  if (!companyName || companyName.trim() === '') {
    return { info: "لم يتم توفير اسم للبحث.", sources: [] };
  }
  
  const prompt = `
    معلومات مستخرجة من الملف:
    اسم الشركة: ${companyName}
    اسم البنك: ${bankName}
    وصف البضاعة (أولي): ${goodsDescription || "غير محدد"}

    المطلوب:
    1. استخدم بحث Google للتحقق من الشركة والبنك والحصول على معلومات حديثة.
    2. قم بصياغة وصف البضاعة المذكور أعلاه بشكل مختصر جداً ومباشر (كلمات قليلة فقط دون تفاصيل زائدة).
    3. اكتب ملخصاً نصياً بسيطاً (Plain Text) ورسمياً جداً.
    
    التنسيق المطلوب للإجابة بالضبط (كل معلومة في سطر منفصل، بدون نجوم أو رموز):

    شركة ${companyName}: [التخصص والمقر باختصار]

    بنك ${bankName}: [نبذة وموقع البنك باختصار]

    البضاعة المذكورة في الفاتورة: [وصف مختصر جداً للبضاعة، مثال: أحذية جاهزة بمختلف أنواعها]

    ملاحظة هامة:
    - لا تستخدم رموز (*) أو (-) أو أي تنسيق markdown.
    - التزم بالتسمية "البضاعة المذكورة في الفاتورة".
    - اجعل المعلومات في سطور منفصلة ومرتبة.
    - لا تكتب مقدمة أو خاتمة.
  `;

  try {
    const response: GenerateContentResponse = await aiClient.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });
    
    const info = response.text || "لم يتم العثور على معلومات إضافية.";
    
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = groundingChunks
      .map((chunk) => chunk.web)
      .filter((web) => web?.uri && web.title)
      .map((web) => ({ uri: web!.uri!, title: web!.title! }));

    return { info, sources };
  } catch (e: any) {
    console.error("Failed to get company info from Gemini/Google Search:", e);
    // Provide a user-friendly message for external service issues
    return { info: `فشل في الحصول على معلومات إضافية (خطأ في الاتصال بخدمة البحث). قد يكون السبب مشكلة في الشبكة أو تجاوزًا لمعدل الاستخدام.`, sources: [] };
  }
};