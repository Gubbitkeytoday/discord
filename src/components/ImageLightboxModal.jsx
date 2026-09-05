import React, { useEffect } from 'react';
import { X, Download, ExternalLink } from 'lucide-react';
import { t } from '../i18n/index.jsx';

export default function ImageLightboxModal({ imageUrl, altText, onClose }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!imageUrl) return null;

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex flex-col items-center justify-center p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Top Header Bar */}
      <div 
        className="absolute top-4 right-4 flex items-center gap-3 bg-d-sunken/80 p-2 rounded-xl border border-d-surface/50 text-gray-300"
        onClick={(e) => e.stopPropagation()}
      >
        <a
          href={imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-2 hover:bg-d-hover2 rounded-lg text-gray-300 hover:text-d-strong transition flex items-center gap-1.5 text-xs font-medium"
          title={t('files.openOriginal')}
        >
          <ExternalLink className="w-4 h-4" />
          <span>{t('files.openOriginal')}</span>
        </a>

        <a
          href={imageUrl}
          download
          className="p-2 hover:bg-d-hover2 rounded-lg text-gray-300 hover:text-d-strong transition flex items-center gap-1.5 text-xs font-medium"
          title={t('files.download')}
        >
          <Download className="w-4 h-4" />
          <span>{t('files.download')}</span>
        </a>

        <button
          onClick={onClose}
          aria-label={t('common.close')}
          className="p-2 hover:bg-d-dangerhover hover:text-white rounded-lg text-gray-400 transition"
          title={t('files.closeEsc')}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Image Preview Container */}
      <div 
        className="max-w-[90vw] max-h-[85vh] flex flex-col items-center justify-center relative"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={imageUrl}
          alt={altText || t('files.expandedAttachment')}
          className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl border border-white/10"
        />
        {altText && (
          <p className="mt-3 text-xs text-gray-400 bg-black/60 px-3 py-1 rounded-full border border-gray-800">
            {altText}
          </p>
        )}
      </div>
    </div>
  );
}
