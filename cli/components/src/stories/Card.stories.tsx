import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';

const meta: Meta<typeof Card> = {
  title: 'Components/Card',
  component: Card,
  argTypes: {
    shadow: { control: 'boolean' },
    hoverable: { control: 'boolean' },
    title: { control: 'text' },
    subtitle: { control: 'text' },
    imageUrl: { control: 'text' },
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  args: {
    children: <p className="text-gray-700">This is a basic card with some content.</p>,
    title: 'Card Title',
  },
};

export const WithSubtitle: Story = {
  args: {
    children: <p className="text-gray-700">Card content goes here.</p>,
    title: 'Featured Article',
    subtitle: 'A short description of the article',
  },
};

export const WithFooter: Story = {
  args: {
    children: <p className="text-gray-700">Main card content</p>,
    title: 'Actions',
    footer: (
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost">Cancel</Button>
        <Button size="sm">Save</Button>
      </div>
    ),
  },
};

export const Hoverable: Story = {
  args: {
    children: <p className="text-gray-700">Hover over me!</p>,
    title: 'Hoverable Card',
    hoverable: true,
  },
};

export const NoShadow: Story = {
  args: {
    children: <p className="text-gray-700">Card without shadow.</p>,
    title: 'Flat Card',
    shadow: false,
  },
};

export const WithImage: Story = {
  args: {
    children: <p className="text-gray-700">A card with an image at the top.</p>,
    title: 'Mountain View',
    subtitle: 'Beautiful landscape',
    imageUrl: 'https://picsum.photos/seed/mountain/400/200',
    imageAlt: 'Mountain landscape',
  },
};

export const ComplexContent: Story = {
  args: {
    children: (
      <div>
        <p className="text-gray-700 mb-3">
          This card demonstrates complex content with multiple elements.
        </p>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <span>👍 42 likes</span>
          <span>💬 12 comments</span>
        </div>
      </div>
    ),
    title: 'Social Post',
    subtitle: 'Posted 2 hours ago',
    hoverable: true,
    footer: (
      <div className="flex gap-2">
        <Button size="sm" variant="ghost">Like</Button>
        <Button size="sm" variant="ghost">Comment</Button>
        <Button size="sm" variant="ghost">Share</Button>
      </div>
    ),
  },
};
