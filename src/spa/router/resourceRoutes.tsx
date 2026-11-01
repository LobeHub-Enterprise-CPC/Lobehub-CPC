'use client';

import {
  FilePenIcon,
  FilesIcon,
  FileText,
  ImageIcon,
  LayoutPanelTopIcon,
  LibraryBigIcon,
  Mic2,
  SquarePlay,
} from 'lucide-react';
import type { RouteObject } from 'react-router';

import { BusinessResourceRoutes } from '@/business/client/BusinessDesktopRoutes';
import ResourceHomeSkeleton from '@/components/Skeleton/ResourceHome';
import { createSurfaceSkeleton } from '@/components/Skeleton/Surface';
import ResourceCategorySkeleton from '@/features/ResourceHome/Skeleton';
import { libraryTreeLoader } from '@/spa/router/libraryTreeLoader';
import { routeMeta } from '@/spa/router/routeMeta';
import { worksLoader } from '@/spa/router/worksLoader';
import { dynamicElement, ErrorBoundary } from '@/utils/router';

const resourceCategoryRoutes: RouteObject[] = [
  { icon: LayoutPanelTopIcon, path: 'all', titleKey: 'navigation.resourceAll' },
  { icon: FileText, path: 'documents', titleKey: 'navigation.resourceDocuments' },
  { icon: ImageIcon, path: 'images', titleKey: 'navigation.resourceImages' },
  { icon: SquarePlay, path: 'videos', titleKey: 'navigation.resourceVideos' },
  { icon: Mic2, path: 'audios', titleKey: 'navigation.resourceAudios' },
  { icon: FilesIcon, path: 'files', titleKey: 'navigation.resourceFiles' },
].map(({ icon, path, titleKey }) => ({
  element: dynamicElement(
    () => import('@/routes/(main)/resource/(home)'),
    `Desktop > Resource > Home > ${path}`,
    { preloadId: 'resource' },
  ),
  handle: { meta: routeMeta({ icon, titleKey }) },
  path,
}));

/**
 * `/resource`: the resource home, its category views and knowledge-base
 * libraries. Mounted by the desktop router and reused by the mobile router
 * (`mobileWorkspaceRoutes.tsx`).
 */
export const resourceRoute: RouteObject = {
  children: [
    // Home routes (resource list)
    {
      children: [
        {
          element: dynamicElement(
            () => import('@/routes/(main)/resource/(home)'),
            'Desktop > Resource > Home',
            { preloadId: 'resource' },
          ),
          handle: {
            meta: routeMeta({
              icon: LibraryBigIcon,
              Skeleton: ResourceHomeSkeleton,
              titleKey: 'navigation.resources',
            }),
          },
          index: true,
          loader: worksLoader,
        },
        ...BusinessResourceRoutes,
        ...resourceCategoryRoutes,
        // /resource/page needs a static segment: the dynamic `:category`
        // ties with the workspace mirror `/:workspaceSlug/page` on route
        // score, and the workspace tree would swallow it into a slug 404.
        {
          element: dynamicElement(
            () => import('@/routes/(main)/resource/(home)'),
            'Desktop > Resource > Home > Pages',
            { preloadId: 'resource' },
          ),
          handle: {
            meta: routeMeta({ icon: FilePenIcon, titleKey: 'navigation.resourcePages' }),
          },
          path: 'page',
        },
        // Category views share the home page: /resource/documents, /resource/images, …
        {
          element: dynamicElement(
            () => import('@/routes/(main)/resource/(home)'),
            'Desktop > Resource > Home > Category',
            { preloadId: 'resource' },
          ),
          handle: {
            meta: routeMeta({ icon: LibraryBigIcon, titleKey: 'navigation.resources' }),
          },
          loader: worksLoader,
          path: ':category',
        },
      ],
      element: dynamicElement(
        () => import('@/routes/(main)/resource/(home)/_layout'),
        'Desktop > Resource > Home > Layout',
        { preloadId: 'resource' },
      ),
      handle: { meta: routeMeta({ Skeleton: ResourceCategorySkeleton }) },
    },
    // Library routes (knowledge base detail)
    {
      children: [
        {
          element: dynamicElement(
            () => import('@/routes/(main)/resource/library'),
            'Desktop > Resource > Library',
          ),
          handle: {
            meta: routeMeta({ icon: LibraryBigIcon, titleKey: 'navigation.knowledgeBase' }),
          },
          index: true,
        },
        {
          element: dynamicElement(
            () => import('@/routes/(main)/resource/library/permission'),
            'Desktop > Resource > Library > Permission',
          ),
          handle: {
            meta: routeMeta({
              icon: LibraryBigIcon,
              Skeleton: createSurfaceSkeleton('form'),
              titleKey: 'navigation.knowledgeBase',
            }),
          },
          path: 'permission',
        },
        {
          element: dynamicElement(
            () => import('@/routes/(main)/resource/library/[slug]'),
            'Desktop > Resource > Library > Slug',
          ),
          handle: {
            meta: routeMeta({ icon: LibraryBigIcon, titleKey: 'navigation.knowledgeBase' }),
          },
          path: ':slug',
        },
      ],
      element: dynamicElement(
        () => import('@/routes/(main)/resource/library/_layout'),
        'Desktop > Resource > Library > Layout',
      ),
      loader: libraryTreeLoader,
      path: 'library/:id',
    },
  ],
  element: dynamicElement(
    () => import('@/routes/(main)/resource/_layout'),
    'Desktop > Resource > Layout',
    { preloadId: 'resource' },
  ),
  errorElement: <ErrorBoundary />,
  handle: { meta: routeMeta({ Skeleton: createSurfaceSkeleton('list') }) },
  path: 'resource',
};
