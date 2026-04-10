export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          description: string | null
          email: string
          id: string
          is_active: boolean
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          rate_limit_rpm: number
          request_count: number
          tier: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          email: string
          id?: string
          is_active?: boolean
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          rate_limit_rpm?: number
          request_count?: number
          tier?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          email?: string
          id?: string
          is_active?: boolean
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          rate_limit_rpm?: number
          request_count?: number
          tier?: string
        }
        Relationships: []
      }
      api_usage_log: {
        Row: {
          created_at: string
          duration_ms: number | null
          endpoint: string
          id: number
          params_hash: string | null
          status_code: number
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          endpoint: string
          id?: number
          params_hash?: string | null
          status_code: number
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          endpoint?: string
          id?: number
          params_hash?: string | null
          status_code?: number
        }
        Relationships: []
      }
      budget_outcomes: {
        Row: {
          agency: string | null
          amount_sek: number | null
          anslag_code: string | null
          anslag_name: string | null
          budget_type: string
          created_at: string
          expenditure_area_code: string
          expenditure_area_name: string | null
          id: number
          month: number | null
          year: number
        }
        Insert: {
          agency?: string | null
          amount_sek?: number | null
          anslag_code?: string | null
          anslag_name?: string | null
          budget_type: string
          created_at?: string
          expenditure_area_code: string
          expenditure_area_name?: string | null
          id?: number
          month?: number | null
          year: number
        }
        Update: {
          agency?: string | null
          amount_sek?: number | null
          anslag_code?: string | null
          anslag_name?: string | null
          budget_type?: string
          created_at?: string
          expenditure_area_code?: string
          expenditure_area_name?: string | null
          id?: number
          month?: number | null
          year?: number
        }
        Relationships: []
      }
      document_authors: {
        Row: {
          document_id: string
          member_id: string
        }
        Insert: {
          document_id: string
          member_id: string
        }
        Update: {
          document_id?: string
          member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_authors_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_authors_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      document_chunks: {
        Row: {
          chunk_index: number
          created_at: string
          document_id: string
          embedding: string | null
          id: number
          text: string
        }
        Insert: {
          chunk_index: number
          created_at?: string
          document_id: string
          embedding?: string | null
          id?: number
          text: string
        }
        Update: {
          chunk_index?: number
          created_at?: string
          document_id?: string
          embedding?: string | null
          id?: number
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      document_texts: {
        Row: {
          body_html: string | null
          body_text: string | null
          document_id: string
          language: string
          word_count: number | null
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          document_id: string
          language?: string
          word_count?: number | null
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          document_id?: string
          language?: string
          word_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "document_texts_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          committee: string | null
          created_at: string
          date: string | null
          document_url: string | null
          id: string
          ingested_at: string | null
          number: string | null
          rm: string
          source_url: string | null
          status: string | null
          subtitle: string | null
          title: string
          type: string
          updated_at: string
        }
        Insert: {
          committee?: string | null
          created_at?: string
          date?: string | null
          document_url?: string | null
          id: string
          ingested_at?: string | null
          number?: string | null
          rm: string
          source_url?: string | null
          status?: string | null
          subtitle?: string | null
          title: string
          type: string
          updated_at?: string
        }
        Update: {
          committee?: string | null
          created_at?: string
          date?: string | null
          document_url?: string | null
          id?: string
          ingested_at?: string | null
          number?: string | null
          rm?: string
          source_url?: string | null
          status?: string | null
          subtitle?: string | null
          title?: string
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      ingestion_runs: {
        Row: {
          completed_at: string | null
          errors: Json | null
          id: number
          records_inserted: number
          records_processed: number
          records_updated: number
          source: string
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          errors?: Json | null
          id?: number
          records_inserted?: number
          records_processed?: number
          records_updated?: number
          source: string
          started_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          errors?: Json | null
          id?: number
          records_inserted?: number
          records_processed?: number
          records_updated?: number
          source?: string
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      manifesto_statements: {
        Row: {
          category_code: string | null
          category_name: string | null
          created_at: string
          embedding: string | null
          id: number
          manifesto_id: number
          position: number | null
          statement_index: number | null
          text: string
        }
        Insert: {
          category_code?: string | null
          category_name?: string | null
          created_at?: string
          embedding?: string | null
          id?: number
          manifesto_id: number
          position?: number | null
          statement_index?: number | null
          text: string
        }
        Update: {
          category_code?: string | null
          category_name?: string | null
          created_at?: string
          embedding?: string | null
          id?: number
          manifesto_id?: number
          position?: number | null
          statement_index?: number | null
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "manifesto_statements_manifesto_id_fkey"
            columns: ["manifesto_id"]
            isOneToOne: false
            referencedRelation: "manifestos"
            referencedColumns: ["id"]
          },
        ]
      }
      manifestos: {
        Row: {
          election_year: number
          id: number
          ingested_at: string
          party_code: string
          party_name: string
          source_url: string | null
        }
        Insert: {
          election_year: number
          id?: number
          ingested_at?: string
          party_code: string
          party_name: string
          source_url?: string | null
        }
        Update: {
          election_year?: number
          id?: number
          ingested_at?: string
          party_code?: string
          party_name?: string
          source_url?: string | null
        }
        Relationships: []
      }
      members: {
        Row: {
          birth_year: number | null
          constituency: string | null
          created_at: string
          first_name: string
          from_date: string | null
          gender: string | null
          id: string
          image_url: string | null
          last_name: string
          party: string
          status: string
          to_date: string | null
          updated_at: string
        }
        Insert: {
          birth_year?: number | null
          constituency?: string | null
          created_at?: string
          first_name: string
          from_date?: string | null
          gender?: string | null
          id: string
          image_url?: string | null
          last_name: string
          party: string
          status?: string
          to_date?: string | null
          updated_at?: string
        }
        Update: {
          birth_year?: number | null
          constituency?: string | null
          created_at?: string
          first_name?: string
          from_date?: string | null
          gender?: string | null
          id?: string
          image_url?: string | null
          last_name?: string
          party?: string
          status?: string
          to_date?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      speeches: {
        Row: {
          anforande_nummer: number | null
          body_text: string | null
          created_at: string
          date: string | null
          document_id: string | null
          id: string
          member_id: string | null
          rm: string
          word_count: number | null
        }
        Insert: {
          anforande_nummer?: number | null
          body_text?: string | null
          created_at?: string
          date?: string | null
          document_id?: string | null
          id: string
          member_id?: string | null
          rm: string
          word_count?: number | null
        }
        Update: {
          anforande_nummer?: number | null
          body_text?: string | null
          created_at?: string
          date?: string | null
          document_id?: string | null
          id?: string
          member_id?: string | null
          rm?: string
          word_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "speeches_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speeches_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      vote_results: {
        Row: {
          member_id: string
          party: string
          result: string
          vote_id: string
        }
        Insert: {
          member_id: string
          party: string
          result: string
          vote_id: string
        }
        Update: {
          member_id?: string
          party?: string
          result?: string
          vote_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vote_results_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vote_results_vote_id_fkey"
            columns: ["vote_id"]
            isOneToOne: false
            referencedRelation: "votes"
            referencedColumns: ["id"]
          },
        ]
      }
      votes: {
        Row: {
          absent_count: number
          abstain_count: number
          created_at: string
          date: string | null
          description: string | null
          document_id: string | null
          id: string
          no_count: number
          outcome: string | null
          rm: string
          yes_count: number
        }
        Insert: {
          absent_count?: number
          abstain_count?: number
          created_at?: string
          date?: string | null
          description?: string | null
          document_id?: string | null
          id: string
          no_count?: number
          outcome?: string | null
          rm: string
          yes_count?: number
        }
        Update: {
          absent_count?: number
          abstain_count?: number
          created_at?: string
          date?: string | null
          description?: string | null
          document_id?: string | null
          id?: string
          no_count?: number
          outcome?: string | null
          rm?: string
          yes_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "votes_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      match_manifesto_statements: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          category_code: string
          category_name: string
          id: number
          manifesto_id: number
          position: number
          similarity: number
          statement_index: number
          text: string
        }[]
      }
      search_documents: {
        Args: {
          doc_rm?: string
          doc_type?: string
          match_count?: number
          query_embedding: string
          query_text: string
        }
        Returns: {
          date: string
          fts_rank: number
          id: string
          rm: string
          source_url: string
          title: string
          type: string
          vec_rank: number
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      unaccent: { Args: { "": string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
