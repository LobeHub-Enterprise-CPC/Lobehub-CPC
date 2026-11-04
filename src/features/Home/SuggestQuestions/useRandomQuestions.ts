import { COMPOSER_AGENT_ONLY_LAYOUT } from '@lobechat/business-const';
import { useCallback, useState } from 'react';

const QUESTION_COUNT = 40;
/** The agent-only product draws agent ideas from its first, work-focused examples. */
const AGENT_QUESTION_COUNT = 12;
const DISPLAY_COUNT = 6;

export type QuestionMode = 'agent' | 'chat' | 'group' | 'write';

const questionCount = (mode: QuestionMode) =>
  mode === 'agent' && COMPOSER_AGENT_ONLY_LAYOUT ? AGENT_QUESTION_COUNT : QUESTION_COUNT;

const shuffleArray = <T>(array: T[]): T[] => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const generateQuestions = (mode: QuestionMode) => {
  const ids = Array.from({ length: questionCount(mode) }, (_, i) => i + 1);
  const shuffled = shuffleArray(ids);
  return shuffled.slice(0, DISPLAY_COUNT).map((id) => ({
    id,
    promptKey: `${mode}.${String(id).padStart(2, '0')}.prompt`,
    titleKey: `${mode}.${String(id).padStart(2, '0')}.title`,
  }));
};

export interface QuestionItem {
  id: number;
  promptKey: string;
  titleKey: string;
}

interface UseRandomQuestionsResult {
  questions: QuestionItem[];
  refresh: () => void;
}

export const useRandomQuestions = (mode: QuestionMode = 'chat'): UseRandomQuestionsResult => {
  const [questions, setQuestions] = useState<QuestionItem[]>(() => generateQuestions(mode));

  const refresh = useCallback(() => {
    setQuestions(generateQuestions(mode));
  }, [mode]);

  return { questions, refresh };
};
