import React from 'react';
import PropTypes from 'prop-types';

export interface CardProps {
  /** Card content */
  children: React.ReactNode;
  /** Optional title displayed in card header */
  title?: string;
  /** Optional subtitle */
  subtitle?: string;
  /** Optional footer content */
  footer?: React.ReactNode;
  /** Whether to show a shadow */
  shadow?: boolean;
  /** Whether card is hoverable (lifts on hover) */
  hoverable?: boolean;
  /** Additional class names */
  className?: string;
  /** Optional image URL to show at the top */
  imageUrl?: string;
  /** Optional image alt text */
  imageAlt?: string;
}

export const Card: React.FC<CardProps> = ({
  children,
  title,
  subtitle,
  footer,
  shadow = true,
  hoverable = false,
  className = '',
  imageUrl,
  imageAlt = '',
}) => {
  const baseStyles = 'bg-white rounded-xl overflow-hidden border border-gray-200';

  const classes = [
    baseStyles,
    shadow ? 'shadow-md' : '',
    hoverable ? 'hover:shadow-lg hover:-translate-y-1 transition-all duration-200 cursor-pointer' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      {imageUrl && (
        <img
          src={imageUrl}
          alt={imageAlt}
          className="w-full h-48 object-cover"
        />
      )}
      {(title || subtitle) && (
        <div className="px-5 pt-5 pb-2">
          {title && (
            <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          )}
          {subtitle && (
            <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
          )}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
      {footer && (
        <div className="px-5 py-3 bg-gray-50 border-t border-gray-200">
          {footer}
        </div>
      )}
    </div>
  );
};

Card.displayName = 'Card';

Card.propTypes = {
  children: PropTypes.node.isRequired,
  title: PropTypes.string,
  subtitle: PropTypes.string,
  footer: PropTypes.node,
  shadow: PropTypes.bool,
  hoverable: PropTypes.bool,
  className: PropTypes.string,
  imageUrl: PropTypes.string,
  imageAlt: PropTypes.string,
};

export default Card;
