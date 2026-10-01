import { act, render, screen } from '@testing-library/react'
import React, { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DynamicVirtualList, type DynamicVirtualListRef } from '..'

// Mock management
const mocks = vi.hoisted(() => ({
  virtualizer: {
    getVirtualItems: vi.fn(() => [
      { index: 0, key: 'item-0', start: 0, size: 50 },
      { index: 1, key: 'item-1', start: 50, size: 50 },
      { index: 2, key: 'item-2', start: 100, size: 50 }
    ]),
    getTotalSize: vi.fn(() => 150),
    getVirtualIndexes: vi.fn(() => [0, 1, 2]),
    measure: vi.fn(),
    scrollToOffset: vi.fn(),
    scrollToIndex: vi.fn(),
    resizeItem: vi.fn(),
    measureElement: vi.fn(),
    scrollElement: null as HTMLDivElement | null
  },
  useVirtualizer: vi.fn()
}))

// Set up the mock to return our mock virtualizer
mocks.useVirtualizer.mockImplementation(() => mocks.virtualizer)

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: mocks.useVirtualizer,
  defaultRangeExtractor: vi.fn((range) =>
    Array.from({ length: range.endIndex - range.startIndex + 1 }, (_, i) => range.startIndex + i)
  )
}))

// Test data factory
interface TestItem {
  id: string
  content: string
}

function createTestItems(count = 5): TestItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${i + 1}`,
    content: `Item ${i + 1}`
  }))
}

describe('DynamicVirtualList', () => {
  const defaultItems = createTestItems()
  const defaultProps = {
    list: defaultItems,
    estimateSize: () => 50,
    children: (item: TestItem, index: number) => <div data-testid={`item-${index}`}>{item.content}</div>
  }

  // Test component for ref testing
  const TestComponentWithRef: React.FC<{
    onRefReady?: (ref: DynamicVirtualListRef | null) => void
    listProps?: any
  }> = ({ onRefReady, listProps = {} }) => {
    const ref = useRef<DynamicVirtualListRef>(null)

    React.useEffect(() => {
      onRefReady?.(ref.current)
    }, [onRefReady])

    return <DynamicVirtualList ref={ref} {...defaultProps} {...listProps} />
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('basic rendering', () => {
    it('snapshot test', () => {
      const { container } = render(<DynamicVirtualList {...defaultProps} />)
      expect(container).toMatchSnapshot()
    })

    it('should apply custom scroller styles', () => {
      const customStyle = { backgroundColor: 'red', height: '400px' }
      render(<DynamicVirtualList {...defaultProps} scrollerStyle={customStyle} />)

      const scrollContainer = document.querySelector('.dynamic-virtual-list')
      expect(scrollContainer).toBeInTheDocument()
      expect(scrollContainer).toHaveStyle('background-color: rgb(255, 0, 0)')
      expect(scrollContainer).toHaveStyle('height: 400px')
    })

    it('should apply custom item container styles', () => {
      const itemStyle = { padding: '10px', margin: '5px' }
      render(<DynamicVirtualList {...defaultProps} itemContainerStyle={itemStyle} />)

      const items = document.querySelectorAll('[data-index]')
      expect(items.length).toBeGreaterThan(0)

      // Check first item styles
      const firstItem = items[0] as HTMLElement
      expect(firstItem).toHaveStyle('padding: 10px')
      expect(firstItem).toHaveStyle('margin: 5px')
    })
  })

  describe('props integration', () => {
    it('should render correctly with different item counts', () => {
      const { rerender } = render(<DynamicVirtualList {...defaultProps} list={createTestItems(3)} />)

      // Should render without errors
      expect(screen.getByTestId('item-0')).toBeInTheDocument()

      // Should handle dynamic item count changes
      rerender(<DynamicVirtualList {...defaultProps} list={createTestItems(10)} />)
      expect(document.querySelector('.dynamic-virtual-list')).toBeInTheDocument()
    })

    it('should work with custom estimateSize function', () => {
      const customEstimateSize = vi.fn(() => 80)

      // Should render without errors when using custom estimateSize
      expect(() => {
        render(<DynamicVirtualList {...defaultProps} estimateSize={customEstimateSize} />)
      }).not.toThrow()

      expect(screen.getByTestId('item-0')).toBeInTheDocument()
    })
  })

  describe('sticky feature', () => {
    it('should apply sticky positioning to specified items', () => {
      const isSticky = vi.fn((index: number) => index === 0) // First item is sticky

      render(<DynamicVirtualList {...defaultProps} isSticky={isSticky} />)

      // Should call isSticky function during rendering
      expect(isSticky).toHaveBeenCalled()

      // Sticky items within visible range should have proper z-index but may be absolute until scrolled
      const stickyItem = document.querySelector('[data-index="0"]') as HTMLElement
      expect(stickyItem).toBeInTheDocument()
      // When sticky item is in visible range, it gets z-index but may not be sticky yet
      expect(stickyItem).toHaveStyle('z-index: 999')
    })

    it('should apply absolute positioning to non-sticky items', () => {
      const isSticky = vi.fn((index: number) => index === 0)

      render(<DynamicVirtualList {...defaultProps} isSticky={isSticky} />)

      // Non-sticky items should have absolute positioning
      const regularItem = document.querySelector('[data-index="1"]') as HTMLElement
      expect(regularItem).toBeInTheDocument()
      expect(regularItem).toHaveStyle('position: absolute')
    })

    it('should apply absolute positioning to all items when no sticky function provided', () => {
      render(<DynamicVirtualList {...defaultProps} />)

      // All items should have absolute positioning
      const items = document.querySelectorAll('[data-index]')
      items.forEach((item) => {
        const htmlItem = item as HTMLElement
        expect(htmlItem).toHaveStyle('position: absolute')
      })
    })
  })

  describe('custom range extractor', () => {
    it('should work with custom rangeExtractor', () => {
      const customRangeExtractor = vi.fn(() => [0, 1, 2])

      // Should render without errors when using custom rangeExtractor
      expect(() => {
        render(<DynamicVirtualList {...defaultProps} rangeExtractor={customRangeExtractor} />)
      }).not.toThrow()

      expect(screen.getByTestId('item-0')).toBeInTheDocument()
    })

    it('should handle both rangeExtractor and sticky props gracefully', () => {
      const customRangeExtractor = vi.fn(() => [0, 1, 2])
      const isSticky = vi.fn((index: number) => index === 0)

      // Should render without conflicts when both props are provided
      expect(() => {
        render(<DynamicVirtualList {...defaultProps} rangeExtractor={customRangeExtractor} isSticky={isSticky} />)
      }).not.toThrow()

      expect(screen.getByTestId('item-0')).toBeInTheDocument()
    })
  })

  describe('ref api', () => {
    let refInstance: DynamicVirtualListRef | null = null

    beforeEach(async () => {
      render(
        <TestComponentWithRef
          onRefReady={(ref) => {
            refInstance = ref
          }}
        />
      )

      // Wait for ref to be ready
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    it('should expose all required ref methods', () => {
      expect(refInstance).toBeTruthy()
      expect(refInstance).not.toBeNull()

      // Type assertion to help TypeScript understand the type
      const ref = refInstance as unknown as DynamicVirtualListRef
      expect(typeof ref.measure).toBe('function')
      expect(typeof ref.scrollElement).toBe('function')
      expect(typeof ref.scrollToOffset).toBe('function')
      expect(typeof ref.scrollToIndex).toBe('function')
      expect(typeof ref.resizeItem).toBe('function')
      expect(typeof ref.getTotalSize).toBe('function')
      expect(typeof ref.getVirtualItems).toBe('function')
      expect(typeof ref.getVirtualIndexes).toBe('function')
    })

    it('should allow calling all ref methods without throwing', () => {
      const ref = refInstance as unknown as DynamicVirtualListRef

      // Test that all methods can be called without errors
      expect(() => ref.measure()).not.toThrow()
      expect(() => ref.scrollToOffset(100, { align: 'start' })).not.toThrow()
      expect(() => ref.scrollToIndex(2, { align: 'center' })).not.toThrow()
      expect(() => ref.resizeItem(1, 80)).not.toThrow()

      // Test that data methods return expected types
      expect(typeof ref.getTotalSize()).toBe('number')
      expect(Array.isArray(ref.getVirtualItems())).toBe(true)
      expect(Array.isArray(ref.getVirtualIndexes())).toBe(true)
    })
  })

  describe('orientation support', () => {
    beforeEach(() => {
      // Reset mocks for orientation tests
      mocks.virtualizer.getVirtualItems.mockReturnValue([
        { index: 0, key: 'item-0', start: 0, size: 100 },
        { index: 1, key: 'item-1', start: 100, size: 100 }
      ])
      mocks.virtualizer.getTotalSize.mockReturnValue(200)
    })

    it('should apply horizontal layout styles correctly', () => {
      render(<DynamicVirtualList {...defaultProps} horizontal={true} />)

      // Verify container styles for horizontal layout
      const container = document.querySelector('div[style*="position: relative"]') as HTMLElement
      expect(container).toHaveStyle('width: 200px') // totalSize
      expect(container).toHaveStyle('height: 100%')

      // Verify item transform for horizontal layout
      const items = document.querySelectorAll('[data-index]')
      const firstItem = items[0] as HTMLElement
      expect(firstItem.style.transform).toContain('translateX(0px)')
      expect(firstItem).toHaveStyle('height: 100%')
    })

    it('should apply vertical layout styles correctly', () => {
      // Reset to default vertical mock values
      mocks.virtualizer.getTotalSize.mockReturnValue(150)

      render(<DynamicVirtualList {...defaultProps} horizontal={false} />)

      // Verify container styles for vertical layout
      const container = document.querySelector('div[style*="position: relative"]') as HTMLElement
      expect(container).toHaveStyle('width: 100%')
      expect(container).toHaveStyle('height: 150px') // totalSize from mock

      // Verify item transform for vertical layout
      const items = document.querySelectorAll('[data-index]')
      const firstItem = items[0] as HTMLElement
      expect(firstItem.style.transform).toContain('translateY(0px)')
      expect(firstItem).toHaveStyle('width: 100%')
    })
  })

  describe('edge cases', () => {
    it('should handle edge cases gracefully', () => {
      // Empty items list
      mocks.virtualizer.getVirtualItems.mockReturnValueOnce([])
      expect(() => {
        render(<DynamicVirtualList {...defaultProps} list={[]} />)
      }).not.toThrow()

      // Null ref
      expect(() => {
        render(<DynamicVirtualList {...defaultProps} ref={null} />)
      }).not.toThrow()

      // Zero estimate size
      expect(() => {
        render(<DynamicVirtualList {...defaultProps} estimateSize={() => 0} />)
      }).not.toThrow()

      // Items without expected properties
      const itemsWithoutContent = [{ id: '1' }, { id: '2' }] as any[]
      expect(() => {
        render(
          <DynamicVirtualList
            {...defaultProps}
            list={itemsWithoutContent}
            children={(_item, index) => <div data-testid={`item-${index}`}>No content</div>}
          />
        )
      }).not.toThrow()
    })
  })

  describe('scroll region accessibility', () => {
    // `aria-hidden` 原先绑在「滚动条要不要显示」上。一旦调用方使用 `autoHideScrollbar`，
    // 停止滚动 2 秒后整块列表（内含可聚焦内容）会被 `aria-hidden` —— 这是 WCAG 4.1.2 违规。
    // 新契约：滚动条显隐只走 `$autoHide`/`$show` 样式，列表对辅助技术始终可见。
    it('never hides the list from assistive technology when autoHideScrollbar is false', () => {
      render(<DynamicVirtualList {...defaultProps} autoHideScrollbar={false} />)

      const scrollContainer = document.querySelector('.dynamic-virtual-list') as HTMLElement
      expect(scrollContainer).toBeInTheDocument()
      expect(scrollContainer).not.toHaveAttribute('aria-hidden')
    })

    it('never hides the list from assistive technology while the scrollbar auto-hides', () => {
      vi.useFakeTimers()

      render(<DynamicVirtualList {...defaultProps} autoHideScrollbar={true} />)

      const scrollContainer = document.querySelector('.dynamic-virtual-list') as HTMLElement
      expect(scrollContainer).toBeInTheDocument()
      expect(scrollContainer).not.toHaveAttribute('aria-hidden')

      const onChangeCallback = mocks.useVirtualizer.mock.calls[0][0].onChange

      act(() => {
        onChangeCallback({ isScrolling: true }, true)
      })
      expect(scrollContainer).not.toHaveAttribute('aria-hidden')

      act(() => {
        onChangeCallback({ isScrolling: false }, true)
      })
      act(() => {
        vi.advanceTimersByTime(10000)
      })

      // 自动隐藏滚动条之后，列表依然不能被 aria-hidden。
      expect(scrollContainer).not.toHaveAttribute('aria-hidden')

      vi.useRealTimers()
    })

    it('exposes a labelled landmark only when ariaLabel is provided', () => {
      const { unmount } = render(<DynamicVirtualList {...defaultProps} />)
      expect(document.querySelector('.dynamic-virtual-list')).not.toHaveAttribute('role')
      unmount()

      render(<DynamicVirtualList {...defaultProps} ariaLabel="Models" />)
      const scrollContainer = document.querySelector('.dynamic-virtual-list') as HTMLElement
      expect(scrollContainer).toHaveAttribute('role', 'region')
      expect(scrollContainer).toHaveAttribute('aria-label', 'Models')
    })
  })

  describe('header placement', () => {
    // header 原先渲染在滚动容器内、测量容器外，高度不参与 `virtualItem.start`，
    // 第一条虚拟行会落在 header 之下（重叠），滚到顶时第 0 行藏在 header 后面。
    it('renders the header outside the scroll container so row offsets stay correct', () => {
      render(<DynamicVirtualList {...defaultProps} header={<div data-testid="list-header">header</div>} />)

      const header = screen.getByTestId('list-header')
      const scrollContainer = document.querySelector('.dynamic-virtual-list') as HTMLElement

      expect(scrollContainer).not.toContainElement(header)
      expect(document.querySelector('.dynamic-virtual-list-header')).toContainElement(header)

      // 第 0 行仍定位在 0 —— 没有被 header 的高度顶下去。
      expect(screen.getByTestId('item-0').parentElement).toHaveStyle({ transform: 'translateY(0px)' })
    })

    it('keeps the previous DOM shape when no header is given', () => {
      render(<DynamicVirtualList {...defaultProps} />)
      expect(document.querySelector('.dynamic-virtual-list-with-header')).toBeNull()
    })
  })
})
