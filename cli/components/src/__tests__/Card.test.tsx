import React from 'react';
import { render, screen } from '@testing-library/react';
import { Card } from '../components/Card';

describe('Card', () => {
  it('renders children content', () => {
    render(<Card>Hello World</Card>);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders title when provided', () => {
    render(<Card title="My Title">Content</Card>);
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<Card title="Title" subtitle="Subtitle text">Content</Card>);
    expect(screen.getByText('Subtitle text')).toBeInTheDocument();
  });

  it('renders footer when provided', () => {
    render(<Card footer={<span>Footer Content</span>}>Content</Card>);
    expect(screen.getByText('Footer Content')).toBeInTheDocument();
  });

  it('applies shadow class by default', () => {
    render(<Card>Content</Card>);
    const card = screen.getByText('Content').closest('div');
    expect(card?.parentElement).toHaveClass('shadow-md');
  });

  it('removes shadow when shadow=false', () => {
    render(<Card shadow={false}>Content</Card>);
    const card = screen.getByText('Content').closest('div');
    expect(card?.parentElement).not.toHaveClass('shadow-md');
  });

  it('applies hoverable classes', () => {
    render(<Card hoverable>Content</Card>);
    const card = screen.getByText('Content').closest('div');
    expect(card?.parentElement).toHaveClass('hover:shadow-lg');
    expect(card?.parentElement).toHaveClass('hover:-translate-y-1');
  });

  it('renders image when imageUrl is provided', () => {
    render(<Card imageUrl="https://example.com/img.jpg" imageAlt="Test image">Content</Card>);
    const img = screen.getByAltText('Test image');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/img.jpg');
  });

  it('accepts custom className', () => {
    render(<Card className="my-custom-class">Content</Card>);
    const card = screen.getByText('Content').closest('div');
    expect(card?.parentElement).toHaveClass('my-custom-class');
  });

  it('does not render title section when no title or subtitle', () => {
    const { container } = render(<Card>Content</Card>);
    // Should not have an h3 element
    expect(container.querySelector('h3')).not.toBeInTheDocument();
  });
});
