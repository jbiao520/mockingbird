import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/ui',workers:1,timeout:90000,expect:{timeout:10000},reporter:'list',use:{viewport:{width:1500,height:980},screenshot:'only-on-failure',trace:'retain-on-failure'}});
