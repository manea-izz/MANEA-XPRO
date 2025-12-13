import React, { useState, useCallback, useEffect, useRef } from 'react';
import { extractDataFromFile, getCompanyInfo } from './services/geminiService';
import { ProcessableFile, EnrichedData, ExtractedData } from './types';
import { UploadIcon, CheckIcon, CrossIcon, InfoIcon, PdfIcon, ImageIcon, FileIcon, TrashIcon, CopyIcon, ClearIcon, WordIcon, ExcelIcon, TextIcon, WhatsAppIcon, FacebookIcon, InstagramIcon, ChevronDownIcon, ChevronUpIcon } from './components/icons';
import Spinner from './components/Spinner';
import { Part } from '@google/genai';

// --- Constants ---
const BANNED_SWIFTS = ['CZCBCN2X', 'CZCBCN2XXXX'];

// --- Worker Code ---
const WORKER_CODE = `
  importScripts('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
  importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

  self.onmessage = async function(e) {
    const { file, id, type } = e.data;
    
    try {
      let result = null;
      let mimeType = file.type;

      // Handle DOCX
      if (type === 'docx' || file.name.endsWith('.docx')) {
        const arrayBuffer = await file.arrayBuffer();
        const extraction = await self.mammoth.extractRawText({ arrayBuffer });
        result = { type: 'text', content: extraction.value };
      } 
      // Handle XLSX / XLS
      else if (type === 'excel' || file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        const arrayBuffer = await file.arrayBuffer();
        const workbook = self.XLSX.read(arrayBuffer, { type: 'buffer' });
        let fullText = '';
        for (const sheetName of workbook.SheetNames) { 
          const worksheet = workbook.Sheets[sheetName];
          const sheetText = self.XLSX.utils.sheet_to_csv(worksheet);
          // Changed from template literal to string concatenation for robustness in worker string literal context
          fullText += '--- ' + sheetName + ' ---\\n' + sheetText + '\\n\\n';
        }
        result = { type: 'text', content: fullText };
      }
      // Handle Text
      else if (type === 'text' || file.name.endsWith('.txt')) {
         const reader = new FileReaderSync();
         const text = reader.readAsText(file);
         result = { type: 'text', content: text };
      }
      // Handle Image / PDF (Base64)
      else {
        const reader = new FileReaderSync();
        // readAsDataURL returns "data:mime/type;base64,..."
        const dataUrl = reader.readAsDataURL(file);
        // Strip the prefix to get raw base64
        const base64 = dataUrl.split(',')[1];
        result = { type: 'base64', content: base64, mimeType: dataUrl.split(';')[0].split(':')[1] };
      }

      self.postMessage({ id, success: true, result });
    } catch (error) {
      self.postMessage({ id, success: false, error: error.message });
    }
  };
`;

// --- Child Components ---

const Toast: React.FC<{ message: string; show: boolean }> = ({ message, show }) => {
    if (!show) return null;
    return (
        <div className="fixed bottom-10 left-1/2 transform -translate-x-1/2 z-50 animate-slide-in-fade-in">
            <div className="bg-brand-gray-900/90 backdrop-blur-md border border-brand-blue/30 text-brand-gray-100 px-6 py-3 rounded-full shadow-2xl flex items-center gap-3">
                <div className="bg-green-500/20 p-1 rounded-full">
                    <CheckIcon className="w-4 h-4 text-green-400" />
                </div>
                <span className="text-sm font-medium">{message}</span>
            </div>
        </div>
    );
};

const ProgressBar: React.FC<{ progress: number; label: string; estimatedTime?: string | null }> = ({ progress, label, estimatedTime }) => {
    const percentage = Math.min(100, Math.max(0, progress));
    const isFinishing = percentage >= 95;

    return (
    <div className="w-full max-w-md mx-auto mt-6 animate-slide-in-fade-in">
        <div className="flex justify-between mb-2 items-end">
            <span className="text-sm font-bold text-brand-blue-light tracking-wide">{label}</span>
            <span className={`text-sm font-bold font-mono transition-colors duration-300 ${percentage === 100 ? 'text-green-400' : 'text-brand-blue-light'}`}>
                {percentage}%
            </span>
        </div>
        
        {/* Progress Track */}
        <div className="w-full bg-brand-gray-900 rounded-full h-4 p-[2px] shadow-inner border border-brand-gray-700/50">
            <div className="h-full w-full rounded-full overflow-hidden relative">
                 {/* Animated Gradient Bar */}
                 <div 
                    className={`
                        h-full rounded-full transition-all duration-500 ease-out
                        bg-gradient-to-r from-blue-600 via-brand-blue to-cyan-400
                        shadow-[0_0_15px_rgba(6,182,212,0.5)]
                        relative
                        ${isFinishing ? 'animate-pulse shadow-[0_0_25px_rgba(34,211,238,0.8)] brightness-110' : ''}
                    `}
                    style={{ width: `${percentage}%` }}
                >
                    {/* Glossy highlight */}
                    <div className="absolute top-0 left-0 right-0 h-[40%] bg-white/20 rounded-t-full"></div>
                    
                    {/* Shimmer animation */}
                    <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/25 to-transparent -translate-x-full animate-shimmer"></div>
                </div>
            </div>
        </div>
        
        {estimatedTime && (
            <p className="text-xs text-brand-gray-400 mt-2 text-right dir-rtl flex justify-end items-center gap-1.5 opacity-80">
                <span className={percentage < 100 ? "animate-spin" : ""}>⏳</span>
                <span>الوقت المتبقي: <span className="font-mono text-brand-gray-300">{estimatedTime}</span></span>
            </p>
        )}
    </div>
    );
};

const DropZone: React.FC<{ onFilesSelect: (files: File[]) => void; multiple: boolean; disabled: boolean; label: string }> = ({ onFilesSelect, multiple, disabled, label }) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      onFilesSelect(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handleDragEvents = (e: React.DragEvent<HTMLDivElement>, isEntering: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(isEntering);
  };
  
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    handleDragEvents(e, false);
    if (!disabled && e.dataTransfer.files?.length) {
      onFilesSelect(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
    }
  };
  
  return (
    <div
      onClick={() => !disabled && fileInputRef.current?.click()}
      onDragEnter={(e) => handleDragEvents(e, true)}
      onDragLeave={(e) => handleDragEvents(e, false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className={`relative w-full p-6 text-center bg-brand-gray-800/50 border-2 border-dashed rounded-xl transition-all duration-300 ease-out flex flex-col items-center justify-center group 
      ${isDragging 
        ? 'border-brand-blue-light bg-brand-blue/5 shadow-[0_0_25px_rgba(0,180,216,0.15)] scale-[1.01] ring-1 ring-brand-blue-light/20' 
        : 'border-brand-gray-700 hover:border-brand-blue-light/50 hover:bg-brand-gray-800/80 hover:shadow-lg'} 
      ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <div className={`pointer-events-none transition-transform duration-300 ${isDragging ? 'scale-110' : 'group-hover:scale-110'}`}>
        <div className={`p-3 rounded-full mb-3 w-fit mx-auto transition-colors ${isDragging ? 'bg-brand-blue/20 text-brand-blue-light' : 'bg-brand-gray-700/50 text-brand-gray-500 group-hover:bg-brand-blue/10 group-hover:text-brand-blue-light'}`}>
             <UploadIcon className={`w-8 h-8 ${isDragging ? 'animate-pulse' : ''}`}/>
        </div>
        <p className={`text-xl font-bold mb-2 transition-colors ${isDragging ? 'text-brand-blue-light' : 'text-brand-gray-200'}`}>{label}</p>
        <p className="text-sm text-brand-gray-400">اضغط للاختيار أو اسحب وأفلت الملفات هنا</p>
      </div>

      <p className="text-xs mt-4 text-brand-gray-500 pointer-events-none border-t border-brand-gray-700 pt-3 w-2/3">يدعم PDF, الصور, Word, Excel, Text</p>
      
      <input 
        ref={fileInputRef}
        type='file' 
        className="hidden" 
        multiple={multiple} 
        onChange={handleFileChange} 
        disabled={disabled} 
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
      />
    </div>
  );
};

const ResultCard: React.FC<{ title: string; data: EnrichedData | null; showCompanyInfo?: boolean }> = ({ title, data, showCompanyInfo = true }) => {
    const [copiedSection, setCopiedSection] = useState<'data' | 'info' | null>(null);
    const [isDataExpanded, setIsDataExpanded] = useState(true);
    const [isInfoExpanded, setIsInfoExpanded] = useState(false);
    const [showToast, setShowToast] = useState(false);

    if (!data) return null;

    // Check for banned swift globally in the card
    const hasBannedSwift = data.swiftCode && BANNED_SWIFTS.includes(data.swiftCode);
    
    // Updated fields order and labels
    const dataFields: { key: keyof ExtractedData; label: string }[] = [
      { key: 'beneficiaryName', label: 'اسم المستفيد' },
      { key: 'accountNumber', label: 'رقم الحساب' },
      { key: 'swiftCode', label: 'سويفت البنك' },
      { key: 'bankName', label: 'أسم البنك' },
      { key: 'country', label: 'الدولة' },
      { key: 'province', label: 'المقاطعة أو الولاية' }, // Updated label and order
      { key: 'city', label: 'المدينة' },
      { key: 'address', label: 'العنوان' },
    ];
    
    const handleCopy = (section: 'data' | 'info') => {
        if (!data) return;
        let textToCopy = '';

        if (section === 'data') {
            const header = "البيانات المستخرجة\n━━━━━━━━━━━━━━━━━━\n\n";
            const fieldsText = dataFields
                .map(({ key, label }) => {
                    const value = data[key as keyof ExtractedData];
                    // Format: Label on one line, Value on next line
                    return value ? `${label}:\n${value}` : null;
                })
                .filter(Boolean)
                .join('\n\n');
            if (fieldsText) {
                textToCopy = header + fieldsText;
            }
        } else { // section === 'info'
            if (data.companyInfo) {
                 // Copy just the text without headers/footers for a clean paste
                textToCopy = data.companyInfo.trim();
            }
        }

        if (textToCopy) {
            navigator.clipboard.writeText(textToCopy);
            setCopiedSection(section);
            setShowToast(true);
            setTimeout(() => {
                setCopiedSection(null);
                setShowToast(false);
            }, 2000);
        }
    };
  
    return (
      <div className={`bg-brand-gray-800 p-6 rounded-xl shadow-lg w-full h-fit flex flex-col transition-all duration-300 border ${hasBannedSwift ? 'border-red-500/50 shadow-[0_0_20px_rgba(239,68,68,0.15)]' : 'border-brand-gray-700'} relative`}>
        <Toast message="تم نسخ البيانات بنجاح" show={showToast} />
        
        {/* Warning Banner for Banned Swift */}
        {hasBannedSwift && (
            <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3 animate-slide-in-fade-in">
                <div className="bg-red-500/20 p-2 rounded-full flex-shrink-0 text-red-400">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                </div>
                <div>
                    <h4 className="text-sm font-bold text-red-400">تحذير أمني: بنك محظور</h4>
                    <p className="text-xs text-brand-gray-300 mt-1 leading-relaxed">
                        رمز السويفت المستخرج ({data.swiftCode}) مدرج في قائمة الحظر. يرجى الحذر عند التعامل مع هذا البنك لتجنب أي مشكلات في الحوالات المالية.
                    </p>
                </div>
            </div>
        )}

        <h3 className="text-xl font-bold text-brand-blue-light mb-4">{title}</h3>
        
        {/* Extracted Data Section */}
        <div className="mb-2 border border-brand-gray-700 rounded-lg overflow-hidden">
            <button 
                onClick={() => setIsDataExpanded(!isDataExpanded)}
                className="w-full flex justify-between items-center p-3 bg-brand-gray-700/50 hover:bg-brand-gray-700 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <h4 className="text-md font-semibold text-brand-gray-200">البيانات المستخرجة</h4>
                </div>
                 <div className="flex items-center gap-2">
                     <div onClick={(e) => { e.stopPropagation(); handleCopy('data'); }} className={`cursor-pointer p-1 rounded hover:bg-brand-gray-600 ${copiedSection === 'data' ? 'text-green-400' : 'text-brand-gray-400'}`} title="نسخ البيانات">
                         {copiedSection === 'data' ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="h-4 w-4" />}
                     </div>
                     {isDataExpanded ? <ChevronUpIcon className="w-5 h-5 text-brand-gray-400" /> : <ChevronDownIcon className="w-5 h-5 text-brand-gray-400" />}
                 </div>
            </button>
            
            {isDataExpanded && (
                <div className="p-4 bg-brand-gray-800/50 space-y-3 animate-slide-in-fade-in">
                     {dataFields.map(({key, label}) => {
                         const value = data[key as keyof ExtractedData];
                         if (!value) return null;
                         
                         const isBannedSwift = key === 'swiftCode' && BANNED_SWIFTS.includes(value);
                         
                         return (
                            <div key={key} className="border-b border-brand-gray-700/50 last:border-0 pb-3 last:pb-0">
                                <p className="text-xs font-semibold text-brand-gray-400 uppercase tracking-wider mb-1">{label}</p>
                                <p className={`${isBannedSwift ? 'text-red-500 font-bold drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]' : 'text-brand-gray-100'} text-right font-mono text-sm break-all`}>
                                    {value}
                                    {isBannedSwift && <span className="block text-[10px] text-red-400 font-bold mt-1 bg-red-500/10 p-1 rounded w-fit mr-auto">⚠️ محظور التعامل معه</span>}
                                </p>
                           </div>
                         );
                     })}
                </div>
            )}
        </div>

        {/* Company Info Section - Only if showCompanyInfo is true */}
        {showCompanyInfo && data.companyInfo && (
            <div className="border border-brand-gray-700 rounded-lg overflow-hidden">
                <button 
                    onClick={() => setIsInfoExpanded(!isInfoExpanded)}
                    className="w-full flex justify-between items-center p-3 bg-brand-gray-700/50 hover:bg-brand-gray-700 transition-colors"
                >
                    <div className="flex items-center gap-2">
                         <InfoIcon className="w-5 h-5 text-brand-blue-400" />
                        <h4 className="text-md font-semibold text-brand-gray-200">معلومات إضافية</h4>
                    </div>
                     <div className="flex items-center gap-2">
                         <div onClick={(e) => { e.stopPropagation(); handleCopy('info'); }} className={`cursor-pointer p-1 rounded hover:bg-brand-gray-600 ${copiedSection === 'info' ? 'text-green-400' : 'text-brand-gray-400'}`} title="نسخ المعلومات">
                             {copiedSection === 'info' ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="h-4 w-4" />}
                         </div>
                         {isInfoExpanded ? <ChevronUpIcon className="w-5 h-5 text-brand-gray-400" /> : <ChevronDownIcon className="w-5 h-5 text-brand-gray-400" />}
                     </div>
                </button>
                
                {isInfoExpanded && (
                    <div className="p-4 bg-brand-gray-800/50 animate-slide-in-fade-in">
                         <p className="text-sm text-brand-gray-300 whitespace-pre-wrap leading-relaxed">{data.companyInfo}</p>
                         {data.sources?.length && (
                            <div className="mt-3 pt-3 border-t border-brand-gray-700/50">
                                <h5 className="text-xs font-semibold text-brand-gray-500 mb-2">المصادر:</h5>
                                <div className="flex flex-wrap gap-2">
                                    {data.sources.map((s, i) => <a key={i} href={s.uri} target="_blank" rel="noopener noreferrer" className="text-xs bg-brand-gray-700 hover:bg-brand-blue-light text-brand-gray-200 px-2 py-1 rounded-full transition-colors truncate max-w-[200px]">{s.title}</a>)}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        )}
      </div>
    );
};

const ComparisonTable: React.FC<{ files: ProcessableFile[] }> = ({ files }) => {
    // Include files that have data, even if status is 'processing' (intermediate state)
    const results = files
        .filter(f => f.data && (f.status === 'done' || f.status === 'processing'))
        .map(f => ({ data: f.data!, fileName: f.file.name, isProcessing: f.status === 'processing' }));
        
    const [copiedColumn, setCopiedColumn] = useState<number | null>(null);
    const [showToast, setShowToast] = useState(false);

    if (!results || results.length === 0) return null;

    // Updated fields order and labels
    const fields: { key: keyof ExtractedData; label: string; isMono?: boolean }[] = [
      { key: 'beneficiaryName', label: 'اسم المستفيد' },
      { key: 'accountNumber', label: 'رقم الحساب', isMono: true },
      { key: 'swiftCode', label: 'سويفت البنك', isMono: true },
      { key: 'bankName', label: 'أسم البنك' },
      { key: 'country', label: 'الدولة' },
      { key: 'province', label: 'المقاطعة أو الولاية' }, // Updated label and order
      { key: 'city', label: 'المدينة' },
      { key: 'address', label: 'العنوان' },
    ];

    const handleCopyFile = (index: number, data: EnrichedData, fileName: string) => {
        // Only extracted data fields, no extra info
        const lines = fields.map(field => {
            const value = data[field.key];
            // Format: Label on one line, Value on next line
            return value ? `${field.label}:\n${value}` : null;
        }).filter(Boolean);

        const formattedText = `البيانات المستخرجة\n━━━━━━━━━━━━━━━━━━\n\n` + lines.join('\n\n');
        
        navigator.clipboard.writeText(formattedText);
        setCopiedColumn(index);
        setShowToast(true);
        setTimeout(() => {
            setCopiedColumn(null);
            setShowToast(false);
        }, 2000);
    };

    return (
        <div className="w-full bg-brand-gray-800 rounded-2xl shadow-2xl border border-brand-gray-700 mt-8 animate-slide-in-fade-in ring-1 ring-white/5 overflow-hidden relative">
            <Toast message="تم نسخ بيانات الملف بنجاح" show={showToast} />
            {/* Table Header Title */}
            <div className="p-6 border-b border-brand-gray-700 bg-brand-gray-900/50 backdrop-blur-sm flex justify-between items-center">
                 <div className="flex items-center gap-3">
                    <div className="p-2 bg-brand-blue/10 rounded-lg text-brand-blue-light ring-1 ring-brand-blue/20">
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                        </svg>
                    </div>
                    <div>
                         <h3 className="text-xl font-bold text-white">البيانات المستخرجة</h3>
                         <p className="text-sm text-brand-gray-400">عرض شامل للبيانات المستخرجة من {results.length} ملفات</p>
                    </div>
                </div>
            </div>

            {/* Table Content */}
            <div className="overflow-x-auto">
                {/* table-fixed ensures columns share remaining space equally */}
                <table className="w-full text-sm text-right text-brand-gray-100 border-collapse table-fixed">
                    <thead className="text-xs text-brand-gray-400 uppercase bg-brand-gray-900">
                        <tr>
                            {/* Fixed width for sticky column */}
                            <th scope="col" className="px-6 py-5 font-bold w-48 sticky right-0 z-20 bg-brand-gray-900 border-b border-brand-gray-700 text-brand-blue-light tracking-wider shadow-lg text-right">
                                الحقل المطلوب
                            </th>
                            {results.map((res, index) => (
                                <th key={index} scope="col" className="px-4 py-5 font-semibold border-b border-brand-gray-700">
                                    <div className="flex items-center justify-between bg-brand-gray-800/80 border border-brand-gray-700 rounded-lg p-2 group hover:border-brand-blue-light/30 transition-colors">
                                        <div className="flex items-center gap-2 overflow-hidden">
                                             <span className="text-brand-blue-light font-bold opacity-50">#{index + 1}</span>
                                             <span className="truncate text-brand-gray-200 block" title={res.fileName}>{res.fileName}</span>
                                        </div>
                                        <div className="flex items-center gap-2 flex-shrink-0">
                                            {res.isProcessing && (
                                                 <div className="animate-spin h-3 w-3 border-2 border-brand-blue-light border-t-transparent rounded-full" title="جاري استكمال المعلومات..."></div>
                                            )}
                                            <button 
                                                onClick={() => handleCopyFile(index, res.data, res.fileName)}
                                                className={`p-1.5 rounded-md transition-all ${copiedColumn === index ? 'bg-green-500/20 text-green-400' : 'bg-brand-gray-700 text-brand-gray-400 hover:bg-brand-blue hover:text-white'}`}
                                                title="نسخ بيانات الملف"
                                            >
                                                {copiedColumn === index ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
                                            </button>
                                        </div>
                                    </div>
                                </td>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-gray-700/30">
                        {fields.map((field) => {
                            return (
                                <tr key={field.key} className="group transition-colors hover:bg-brand-gray-700/30 even:bg-brand-gray-800/30 odd:bg-brand-gray-800/10">
                                    <th className="px-6 py-5 font-bold text-brand-gray-200 sticky right-0 z-10 border-l border-brand-gray-700 bg-brand-gray-800 shadow-[4px_0_24px_-2px_rgba(0,0,0,0.5)] group-hover:bg-brand-gray-800/90 transition-colors text-right align-top">
                                        <div className="flex items-center gap-2 mt-1">
                                             <span className="w-1.5 h-1.5 rounded-full bg-brand-blue-light/50 group-hover:bg-brand-blue-light transition-colors flex-shrink-0"></span>
                                             <span className="tracking-wide">{field.label}</span>
                                        </div>
                                    </th>
                                    {results.map((res, index) => {
                                        const val = res.data[field.key];
                                        const isBannedSwift = field.key === 'swiftCode' && val && BANNED_SWIFTS.includes(val);

                                        let cellClass = `px-6 py-5 text-sm align-top border-l border-brand-gray-700/20 last:border-0 transition-colors text-right `;
                                        if (isBannedSwift) {
                                            cellClass += 'font-mono font-bold text-red-500 drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] group-hover:text-red-400';
                                        } else {
                                            cellClass += `${field.isMono ? 'font-mono tracking-tight text-blue-200' : 'font-sans leading-relaxed text-brand-gray-300'} group-hover:text-white`;
                                        }

                                        return (
                                            <td key={index} className={cellClass}>
                                               <div className="break-words whitespace-pre-wrap w-full">
                                                  {val ? (
                                                      <>
                                                        {val}
                                                        {isBannedSwift && <span className="block text-[10px] text-red-400 font-bold mt-1 whitespace-nowrap bg-red-500/10 px-1 rounded w-fit mx-auto">⚠️ بنك محظور</span>}
                                                      </>
                                                  ) : <span className="text-brand-gray-600 opacity-30 select-none text-xl font-light">−</span>}
                                               </div>
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

// --- Main App Component ---

function App() {
  const [singleFile, setSingleFile] = useState<File | null>(null);
  const [processableFiles, setProcessableFiles] = useState<ProcessableFile[]>([]);
  const [singleResult, setSingleResult] = useState<EnrichedData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'single' | 'multi'>('single');
  
  // States for progress bar
  const [progress, setProgress] = useState(0);
  const [processingStatus, setProcessingStatus] = useState<'idle' | 'reading' | 'analyzing'>('idle');
  const [estimatedTime, setEstimatedTime] = useState<string | null>(null);
  
  // Worker Reference
  const workerRef = useRef<Worker | null>(null);
  const workerCallbacks = useRef<Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>>(new Map());

  useEffect(() => {
    // Initialize Web Worker
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    workerRef.current = worker;

    worker.onmessage = (e) => {
        const { id, success, result, error } = e.data;
        const cb = workerCallbacks.current.get(id);
        if (cb) {
            if (success) cb.resolve(result);
            else cb.reject(new Error(error));
            workerCallbacks.current.delete(id);
        }
    };
    
    return () => {
        worker.terminate();
    };
  }, []);

  const processFileWithWorker = (file: File, type: 'docx' | 'excel' | 'text' | 'base64'): Promise<{ type: string; content: string; mimeType?: string }> => {
    return new Promise((resolve, reject) => {
        if (!workerRef.current) {
            reject(new Error("Worker not initialized"));
            return;
        }
        const id = Math.random().toString(36).substring(7);
        workerCallbacks.current.set(id, { resolve, reject });
        workerRef.current.postMessage({ file, id, type });
    });
  };

  const prepareContentPart = async (file: File, onProgress?: (percent: number) => void): Promise<Part> => {
    const { type, name } = file;
    let result;

    try {
        if (type.startsWith('image/') || type === 'application/pdf') {
            result = await processFileWithWorker(file, 'base64');
            if (onProgress) onProgress(100);
            return { inlineData: { mimeType: result.mimeType || type, data: result.content } };
        } 
        else if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')) { // Corrected MIME type
            result = await processFileWithWorker(file, 'docx');
            if (onProgress) onProgress(100);
            return { text: result.content };
        } 
        else if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || name.endsWith('.xlsx') || name.endsWith('.xls')) {
            result = await processFileWithWorker(file, 'excel');
            if (onProgress) onProgress(100);
            return { text: result.content };
        } 
        else if (type.startsWith('text/') || name.endsWith('.txt')) {
            result = await processFileWithWorker(file, 'text');
            if (onProgress) onProgress(100);
            return { text: result.content };
        }
        
        // Fallback for generic binary types that might not have exact mime types
        // Try to process as base64 first (e.g., from Drive)
        result = await processFileWithWorker(file, 'base64');
        if (onProgress) onProgress(100);
        return { inlineData: { mimeType: result.mimeType || 'application/octet-stream', data: result.content } };
    } catch (e: any) {
        console.error(`Error processing file ${file.name} with worker:`, e);
        throw new Error(`فشل في قراءة الملف أو نوعه غير مدعوم: ${file.name} (${e.message}). يرجى التأكد من أن الملف سليم ومن نوع مدعوم.`);
    }
  };

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (isLoading) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length > 0) {
        // New logic for automatic tab switching
        if (files.length > 1 && activeTab === 'single') {
          setActiveTab('multi');
        } 
        // If files.length === 1 and activeTab === 'multi', it will now remain in 'multi' tab and handleFilesSelected will add it to processableFiles.
        handleFilesSelected(files);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeTab, isLoading]); // Depend on activeTab to get the latest value

  const handleFilesSelected = (files: File[]) => {
      setError(null);
      if (activeTab === 'single') {
        setSingleFile(files[0]);
        setSingleResult(null);
        // Clear multi-file state to avoid confusion if we switched from multi to single
        setProcessableFiles([]); 
      } else { // activeTab === 'multi'
        const newProcessableFiles = files.map(file => ({ file, status: 'pending' as const, id: `${file.name}-${Date.now()}-${Math.random()}` }));
        setProcessableFiles(prev => [...prev, ...newProcessableFiles]);
        // Clear single-file state to avoid confusion if we switched from single to multi
        setSingleFile(null);
        setSingleResult(null);
      }
  };

  const handleClear = () => {
    setError(null);
    if (activeTab === 'single') {
      setSingleFile(null);
      setSingleResult(null);
      setProcessingStatus('idle');
      setProgress(0);
      setEstimatedTime(null);
    } else {
      setProcessableFiles([]);
    }
  };

  const handleRemoveMultiFile = (idToRemove: string) => {
    setProcessableFiles(files => files.filter(f => f.id !== idToRemove));
  };

  const handleProcessSingleFile = useCallback(async () => {
    if (!singleFile) return;
    setIsLoading(true);
    setError(null);
    setSingleResult(null);
    setProcessingStatus('reading');
    setProgress(0);
    setEstimatedTime(null);

    let intervalId: any;

    try {
      // Reading phase: 0% to 30%
      const contentPart = await prepareContentPart(singleFile, (percent) => {
          // Reading is the first 30% of the total progress
          setProgress(Math.round(percent * 0.3));
      });

      setProcessingStatus('analyzing');
      
      // Estimate time: 
      // Base 5s latency + ~2s per MB of file size
      const sizeMB = singleFile.size / (1024 * 1024);
      const estimatedSeconds = Math.ceil(5 + (sizeMB * 2));
      setEstimatedTime(`${estimatedSeconds} ثانية`);

      // Simulating analysis progress from 30% to 95%
      let currentSimulated = 30;
      const maxSimulated = 95;
      const stepTime = (estimatedSeconds * 1000) / (maxSimulated - currentSimulated);
      
      intervalId = setInterval(() => {
          currentSimulated += 1;
          if (currentSimulated <= maxSimulated) {
              setProgress(currentSimulated);
              // Decrement estimated time roughly
              const remaining = Math.ceil(estimatedSeconds * (1 - ((currentSimulated - 30) / (maxSimulated - 30))));
              if (remaining > 0) setEstimatedTime(`${remaining} ثانية`);
              else setEstimatedTime("لحظات أخيرة...");
          }
      }, stepTime / 1.5); // Speed up slightly to feel responsive

      const extractedData = await extractDataFromFile(contentPart);
      const { info, sources } = await getCompanyInfo(extractedData.beneficiaryName, extractedData.bankName, extractedData.goodsDescription);
      
      setProgress(100);
      setEstimatedTime("تم!");
      
      // Short delay to let user see 100%
      await new Promise(r => setTimeout(r, 500));

      setSingleResult({ ...extractedData, companyInfo: info, sources });
    } catch (err: any) {
      console.error("Error processing single file:", err);
      // Display specific error message to user
      setError(err.message || 'حدث خطأ غير متوقع أثناء معالجة الملف. يرجى المحاولة مرة أخرى.');
    } finally {
      clearInterval(intervalId);
      setIsLoading(false);
      setProcessingStatus('idle');
    }
  }, [singleFile]);
  
  const handleProcessMultiFile = useCallback(async () => {
    // Identify pending files
    const filesToProcess = processableFiles.filter(pf => pf.status === 'pending');
    
    if (filesToProcess.length === 0 && processableFiles.filter(pf => pf.data).length < 2) {
      setError("يرجى رفع ملفين على الأقل للاستخراج المتعدد. يمكنك استخدام وضع 'فحص ملف واحد' لملف واحد.");
      return;
    }
    
    if (filesToProcess.length === 0) return;

    setIsLoading(true);
    setError(null); // Clear overall error for multi-file processing, individual errors are per file

    // --- Queue/Concurrency Configuration ---
    const CONCURRENCY_LIMIT = 5; // Increased limit for better parallel performance
    const queue = [...filesToProcess];
    const activePromises: Promise<void>[] = [];

    // --- Helper to process a single file from queue ---
    const processOneFile = async (pf: ProcessableFile) => {
        // Mark as processing
        setProcessableFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'processing', error: undefined } : f)); // Clear previous errors
        
        try {
            const part = await prepareContentPart(pf.file);
            
            // Step 1: Extract Data (OCR/Parsing)
            const data = await extractDataFromFile(part);
            
            // IMMEDIATE UPDATE: Show data in table as soon as extraction is done, before searching for extra info.
            // This significantly reduces perceived latency.
            setProcessableFiles(prev => prev.map(f => f.id === pf.id ? { ...f, data: data } : f));
            
            // Step 2: Enrich Data (Google Search) - Happens in background while data is already visible
            const { info, sources } = await getCompanyInfo(data.beneficiaryName, data.bankName, data.goodsDescription);
            const enrichedData: EnrichedData = { ...data, companyInfo: info, sources };
            
            // Final Update: Mark as done and add extra info
            setProcessableFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'done', data: enrichedData } : f));
        } catch (err: any) {
            console.error(`Error processing file ${pf.file.name}:`, err);
            setProcessableFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'error', error: err.message || 'خطأ غير معروف أثناء المعالجة.' } : f));
        }
    };

    // --- Queue Execution Logic ---
    while (queue.length > 0 || activePromises.length > 0) {
        while (queue.length > 0 && activePromises.length < CONCURRENCY_LIMIT) {
            const file = queue.shift()!;
            const promise = processOneFile(file).then(() => {
                // Remove the promise from activePromises once it settles
                activePromises.splice(activePromises.indexOf(promise), 1);
            });
            activePromises.push(promise);
        }
        if (activePromises.length > 0) {
            // Wait for at least one active promise to complete before continuing
            await Promise.race(activePromises);
        } else if (queue.length > 0) {
             // This case should ideally not happen if CONCURRENCY_LIMIT is positive and queue.length > 0
             // but added as a safeguard to prevent infinite loops if activePromises somehow remains empty while queue still has items
            await new Promise(resolve => setTimeout(resolve, 100)); 
        }
    }

    setIsLoading(false);
  }, [processableFiles]);
  
  const getFileIcon = (file: File, className: string) => {
    const { type, name } = file;
    if (type.startsWith('image/')) return <ImageIcon className={className} />;
    if (type === 'application/pdf') return <PdfIcon className={className} />;
    if (type.includes('word') || name.endsWith('.docx')) return <WordIcon className={className} />;
    if (type.includes('excel') || type.includes('spreadsheet') || name.endsWith('.xlsx') || name.endsWith('.xls')) return <ExcelIcon className={className} />;
    if (type.startsWith('text/') || name.endsWith('.txt')) return <TextIcon className={className} />;
    return <FileIcon className={className} />;
  };

  const renderStatusIndicator = (status: ProcessableFile['status'], errorMsg?: string) => {
    switch (status) {
        case 'processing': return <div className="animate-spin rounded-full h-4 w-4 border-2 border-transparent border-t-brand-blue-light border-r-brand-blue-light" title="جاري المعالجة..."></div>;
        case 'done': return <CheckIcon className="w-5 h-5 text-green-400" title="تم بنجاح" />;
        case 'error': return <CrossIcon className="w-5 h-5 text-red-400" title={errorMsg || "حدث خطأ"} />;
        default: return <div className="h-2 w-2 rounded-full bg-brand-gray-600" title="قيد الانتظار"></div>;
    }
  };

  return (
    <div className="min-h-screen text-brand-gray-100 p-4 sm:p-8 flex flex-col">
      <header className="text-center mb-10">
        <h1 className="text-4xl sm:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-brand-blue-light to-brand-blue">مانع برو</h1>
        <p className="text-lg text-brand-gray-400 mt-2">أداة فحص واستخراج البيانات الذكية</p>
      </header>
      <main className="flex-grow w-full max-w-6xl mx-auto bg-brand-gray-800/20 p-4 sm:p-8 rounded-2xl border border-brand-gray-700/50 shadow-2xl shadow-black/20">
        {error && <p className="text-red-400 my-4 text-center bg-red-900/20 border border-red-900/50 p-3 rounded-lg max-w-2xl mx-auto text-sm">{error}</p>}
        
        <div>
            <div className="flex justify-center mb-8 bg-brand-gray-800 p-1 rounded-full w-fit mx-auto shadow-md">
                {['single', 'multi'].map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab as any)} className={`px-6 py-2 text-md font-medium transition-all rounded-full ${activeTab === tab ? 'bg-brand-blue text-white shadow-lg' : 'text-brand-gray-400 hover:text-white'}`}>
                    {tab === 'single' ? 'فحص ملف واحد' : 'استخراج متعدد'}
                  </button>
                ))}
            </div>
            {activeTab === 'single' ? (
                 <div className="w-full max-w-2xl mx-auto">
                    <div className="flex flex-col items-center gap-4">
                        <DropZone 
                            onFilesSelect={handleFilesSelected}
                            multiple={false} 
                            disabled={isLoading || !!singleFile} 
                            label="اختر ملفًا"
                        />
                        {singleFile && <div className="flex items-center justify-between w-full max-w-md bg-brand-gray-800 px-4 py-3 rounded-lg border border-brand-gray-700 shadow-md animate-slide-in-fade-in">
                            <div className="flex items-center gap-3 overflow-hidden">
                                {getFileIcon(singleFile, "w-6 h-6")}
                                <span className="text-sm text-brand-gray-300 truncate font-medium" title={singleFile.name}>{singleFile.name}</span>
                            </div>
                            <button onClick={() => { setSingleFile(null); handleClear(); }} className="text-gray-500 hover:text-red-400 p-1.5 rounded-full hover:bg-brand-gray-700 transition-colors"><TrashIcon className="h-4 w-4" /></button>
                        </div>}
                        
                        {/* Progress Bar during loading */}
                        {isLoading && processingStatus !== 'idle' && (
                            <ProgressBar 
                                progress={progress} 
                                label={processingStatus === 'reading' ? 'جاري قراءة الملف...' : 'جاري تحليل البيانات بالذكاء الاصطناعي...'}
                                estimatedTime={estimatedTime}
                            />
                        )}

                        <div className="w-full flex items-stretch gap-2 mt-2">
                            <button onClick={handleProcessSingleFile} disabled={!singleFile || isLoading} className="flex-grow bg-brand-blue hover:bg-brand-blue-light text-white font-bold py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-brand-blue/20">{isLoading ? <Spinner/> : 'فحص واستخراج البيانات'}</button>
                            {(singleResult || error || singleFile) && !isLoading && <button onClick={handleClear} className="flex-shrink-0 bg-brand-gray-700 hover:bg-brand-gray-600 text-white font-bold p-3 rounded-lg transition-colors shadow-lg"><ClearIcon className="w-5 h-5" /></button>}
                        </div>
                    </div>
                    {singleResult && <div className="mt-8 animate-slide-in-fade-in"><ResultCard title="البيانات المستخرجة" data={singleResult} /></div>}
                </div>
            ) : (
                 <div className="w-full max-w-6xl mx-auto">
                    <div className="flex flex-col items-center gap-6">
                        <DropZone 
                            onFilesSelect={handleFilesSelected} 
                            multiple={true} 
                            disabled={isLoading} 
                            label="اختر ملفين أو أكثر"
                        />
                        
                        {processableFiles.length > 0 && (
                            <div className="w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                    {processableFiles.map(pf => (
                                        <div key={pf.id} className="group relative flex items-center gap-3 p-2 bg-brand-gray-800 border border-brand-gray-700 rounded-lg hover:border-brand-blue-light/50 hover:shadow-[0_4px_12px_rgba(0,0,0,0.2)] transition-all duration-200 h-14 overflow-hidden cursor-default">
                                            {/* Icon */}
                                            <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center bg-brand-gray-700/40 rounded-md text-brand-gray-300">
                                                {getFileIcon(pf.file, "w-5 h-5")}
                                            </div>

                                            {/* Info */}
                                            <div className="flex-grow min-w-0 flex flex-col justify-center h-full overflow-hidden">
                                                <p className="text-xs font-bold text-brand-gray-200 truncate w-full" title={pf.file.name}>
                                                    {pf.file.name}
                                                </p>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] text-brand-gray-500 font-mono">{(pf.file.size / 1024).toFixed(0)} KB</span>
                                                    {/* Status Indicator */}
                                                    <div className="mr-auto flex-shrink-0">
                                                        {renderStatusIndicator(pf.status, pf.error)}
                                                    </div>
                                                </div>
                                                {/* Display error message if present */}
                                                {pf.status === 'error' && pf.error && (
                                                    <p className="text-[10px] text-red-300 mt-1 truncate w-full" title={pf.error}>
                                                        {pf.error}
                                                    </p>
                                                )}
                                            </div>

                                            {/* Remove Button (Hover) */}
                                            <button 
                                                onClick={() => handleRemoveMultiFile(pf.id)} 
                                                className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-brand-gray-800 to-transparent flex items-center justify-center text-brand-gray-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all transform translate-x-2 group-hover:translate-x-0"
                                                title="إزالة الملف"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                                                </svg>
                                            </button>
                                        </div>
                                    ))}
                            </div>
                        )}
                        
                        <div className="w-full flex items-stretch gap-2 max-w-2xl mt-4">
                            <button onClick={handleProcessMultiFile} disabled={processableFiles.length < 2 || isLoading} className="flex-grow bg-brand-blue hover:bg-brand-blue-light text-white font-bold py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-brand-blue/20">{isLoading ? <Spinner/> : 'استخراج البيانات'}</button>
                            {(processableFiles.length > 0) && !isLoading && <button onClick={handleClear} className="flex-shrink-0 bg-brand-gray-700 hover:bg-brand-gray-600 text-white font-bold p-3 rounded-lg transition-colors shadow-lg"><ClearIcon className="w-5 h-5" /></button>}
                        </div>
                    </div>
                    {/* Show ComparisonTable if any file has data, even if partially processed */}
                    {processableFiles.some(f => f.data) && <ComparisonTable files={processableFiles} />}
                </div>
            )}
        </div>
      </main>
      <footer className="text-center mt-12 text-sm text-brand-gray-600 pb-4">
        <p>تم التطوير بواسطة مانع عزالدين عبر تقنيات الذكاء الاصطناعي المتقدمة.</p>
        <div className="flex justify-center items-center gap-4 mt-4">
            <a href="https://wa.me/967772655825" target="_blank" rel="noopener noreferrer" className="text-brand-gray-400 hover:text-green-500 transition-colors" title="واتساب">
                <WhatsAppIcon />
            </a>
            <a href="https://www.facebook.com/9l7iz" target="_blank" rel="noopener noreferrer" className="text-brand-gray-400 hover:text-blue-500 transition-colors" title="فيسبوك">
                <FacebookIcon />
            </a>
            <a href="https://www.instagram.com/9l7iz" target="_blank" rel="noopener noreferrer" className="text-brand-gray-400 hover:text-pink-500 transition-colors" title="انستجرام">
                <InstagramIcon />
            </a>
        </div>
      </footer>
    </div>
  );
}

export default App;