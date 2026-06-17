import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '../components/Button';

describe('Button', () => {
  it('renders children text', () => {
    render(<Button>Click Me</Button>);
    expect(screen.getByText('Click Me')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const handleClick = jest.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    fireEvent.click(screen.getByText('Click'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('does not call onClick when disabled', () => {
    const handleClick = jest.fn();
    render(<Button onClick={handleClick} disabled>Click</Button>);
    fireEvent.click(screen.getByText('Click'));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('applies disabled attribute', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByText('Disabled')).toBeDisabled();
  });

  it('applies variant classes', () => {
    const { rerender } = render(<Button variant="primary">Btn</Button>);
    expect(screen.getByText('Btn')).toHaveClass('bg-primary-600');

    rerender(<Button variant="danger">Btn</Button>);
    expect(screen.getByText('Btn')).toHaveClass('bg-red-600');

    rerender(<Button variant="ghost">Btn</Button>);
    expect(screen.getByText('Btn')).toHaveClass('bg-transparent');
  });

  it('applies size classes', () => {
    const { rerender } = render(<Button size="sm">Btn</Button>);
    expect(screen.getByText('Btn')).toHaveClass('text-sm');

    rerender(<Button size="lg">Btn</Button>);
    expect(screen.getByText('Btn')).toHaveClass('text-lg');
  });

  it('applies fullWidth class', () => {
    render(<Button fullWidth>Full</Button>);
    expect(screen.getByText('Full')).toHaveClass('w-full');
  });

  it('uses default type="button"', () => {
    render(<Button>Btn</Button>);
    expect(screen.getByText('Btn')).toHaveAttribute('type', 'button');
  });

  it('accepts custom className', () => {
    render(<Button className="custom-class">Btn</Button>);
    expect(screen.getByText('Btn')).toHaveClass('custom-class');
  });

  it('renders with type submit', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByText('Submit')).toHaveAttribute('type', 'submit');
  });
});
