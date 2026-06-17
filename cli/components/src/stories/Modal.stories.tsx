import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Modal } from '../components/Modal';
import { Button } from '../components/Button';

const meta: Meta<typeof Modal> = {
  title: 'Components/Modal',
  component: Modal,
  argTypes: {
    isOpen: { control: 'boolean' },
    size: { control: 'select', options: ['sm', 'md', 'lg', 'xl'] },
    closeOnOverlay: { control: 'boolean' },
    closeOnEsc: { control: 'boolean' },
    title: { control: 'text' },
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof Modal>;

export const Default: Story = {
  args: {
    isOpen: true,
    title: 'Modal Title',
    children: <p className="text-gray-700">This is the modal content. You can put anything here.</p>,
    onClose: () => alert('Close clicked'),
  },
};

export const WithFooter: Story = {
  args: {
    isOpen: true,
    title: 'Confirm Action',
    children: <p className="text-gray-700">Are you sure you want to proceed with this action?</p>,
    footer: (
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={() => alert('Cancel')}>Cancel</Button>
        <Button variant="danger" onClick={() => alert('Confirmed')}>Confirm</Button>
      </div>
    ),
    onClose: () => alert('Close clicked'),
  },
};

export const Small: Story = {
  args: {
    isOpen: true,
    title: 'Small Modal',
    size: 'sm',
    children: <p className="text-gray-700">A compact modal for quick actions.</p>,
    onClose: () => alert('Close clicked'),
  },
};

export const Large: Story = {
  args: {
    isOpen: true,
    title: 'Large Modal',
    size: 'lg',
    children: (
      <div className="space-y-4">
        <p className="text-gray-700">This modal has more space for content.</p>
        <p className="text-gray-700">You can put forms, tables, or any complex content here.</p>
        <div className="bg-gray-100 rounded-lg p-4">
          <p className="text-sm text-gray-600">Additional information panel</p>
        </div>
      </div>
    ),
    onClose: () => alert('Close clicked'),
  },
};

export const ExtraLarge: Story = {
  args: {
    isOpen: true,
    title: 'Extra Large Modal',
    size: 'xl',
    children: (
      <div className="space-y-4">
        <p className="text-gray-700">Maximum width modal for dashboards and complex forms.</p>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-100 rounded-lg p-4 h-24 flex items-center justify-center text-gray-500">Section 1</div>
          <div className="bg-gray-100 rounded-lg p-4 h-24 flex items-center justify-center text-gray-500">Section 2</div>
          <div className="bg-gray-100 rounded-lg p-4 h-24 flex items-center justify-center text-gray-500">Section 3</div>
          <div className="bg-gray-100 rounded-lg p-4 h-24 flex items-center justify-center text-gray-500">Section 4</div>
        </div>
      </div>
    ),
    onClose: () => alert('Close clicked'),
  },
};

export const NoTitle: Story = {
  args: {
    isOpen: true,
    children: (
      <div className="text-center py-4">
        <p className="text-gray-700 mb-2">A modal without a title bar.</p>
        <Button onClick={() => alert('Got it')}>Got it</Button>
      </div>
    ),
    onClose: () => alert('Close clicked'),
  },
};

export const LongContent: Story = {
  args: {
    isOpen: true,
    title: 'Terms & Conditions',
    size: 'lg',
    children: (
      <div className="text-gray-700 space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <p key={i}>
            Section {i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.
            Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
            Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
          </p>
        ))}
      </div>
    ),
    footer: (
      <div className="flex gap-2 justify-end">
        <Button variant="ghost">Decline</Button>
        <Button>Accept</Button>
      </div>
    ),
    onClose: () => alert('Close clicked'),
  },
};
