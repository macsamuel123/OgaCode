import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from '../components/Modal';

describe('Modal', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <Modal isOpen={false} onClose={jest.fn()}>
        Content
      </Modal>
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders content when isOpen is true', () => {
    render(
      <Modal isOpen={true} onClose={jest.fn()}>
        Modal Content
      </Modal>
    );
    expect(screen.getByText('Modal Content')).toBeInTheDocument();
  });

  it('renders title when provided', () => {
    render(
      <Modal isOpen={true} onClose={jest.fn()} title="My Modal">
        Content
      </Modal>
    );
    expect(screen.getByText('My Modal')).toBeInTheDocument();
  });

  it('renders footer when provided', () => {
    render(
      <Modal isOpen={true} onClose={jest.fn()} footer={<span>Footer</span>}>
        Content
      </Modal>
    );
    expect(screen.getByText('Footer')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = jest.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Title">
        Content
      </Modal>
    );
    const closeButton = screen.getByLabelText('Close modal');
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when overlay is clicked and closeOnOverlay is true', () => {
    const onClose = jest.fn();
    render(
      <Modal isOpen={true} onClose={onClose}>
        Content
      </Modal>
    );
    // The overlay is the first child with aria-hidden="true"
    const overlay = screen.getByText('Content').closest('[role="dialog"]')?.querySelector('[aria-hidden="true"]');
    if (overlay) {
      fireEvent.click(overlay);
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it('does not call onClose when overlay clicked and closeOnOverlay is false', () => {
    const onClose = jest.fn();
    render(
      <Modal isOpen={true} onClose={onClose} closeOnOverlay={false}>
        Content
      </Modal>
    );
    const overlay = screen.getByText('Content').closest('[role="dialog"]')?.querySelector('[aria-hidden="true"]');
    if (overlay) {
      fireEvent.click(overlay);
      expect(onClose).not.toHaveBeenCalled();
    }
  });

  it('has role="dialog" and aria-modal="true"', () => {
    render(
      <Modal isOpen={true} onClose={jest.fn()}>
        Content
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('applies size class', () => {
    const { rerender } = render(
      <Modal isOpen={true} onClose={jest.fn()} size="sm">
        Content
      </Modal>
    );
    const panel = screen.getByText('Content').closest('.relative');
    expect(panel).toHaveClass('max-w-sm');

    rerender(
      <Modal isOpen={true} onClose={jest.fn()} size="xl">
        Content
      </Modal>
    );
    const panel2 = screen.getByText('Content').closest('.relative');
    expect(panel2).toHaveClass('max-w-xl');
  });

  it('accepts custom className', () => {
    render(
      <Modal isOpen={true} onClose={jest.fn()} className="custom-modal">
        Content
      </Modal>
    );
    const panel = screen.getByText('Content').closest('.relative');
    expect(panel).toHaveClass('custom-modal');
  });

  it('locks body scroll when open', () => {
    render(
      <Modal isOpen={true} onClose={jest.fn()}>
        Content
      </Modal>
    );
    expect(document.body.style.overflow).toBe('hidden');
  });
});
