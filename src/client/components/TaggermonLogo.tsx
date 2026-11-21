import React from 'react';

export const TaggermonLogo: React.FC<{ className?: string }> = ({
  className = '',
}) => {
  return (
    <div
      className={`inline-flex items-center select-none shrink-0 ${className}`}
      title="Taggermon — All-Purpose Media Tag Editor & Library Organizer"
      aria-label="Taggermon"
    >
      <img
        src="/logo-srcery.png"
        alt="Taggermon"
        className="h-9 sm:h-11 w-auto object-contain block"
        draggable={false}
      />
    </div>
  );
};

export default TaggermonLogo;
