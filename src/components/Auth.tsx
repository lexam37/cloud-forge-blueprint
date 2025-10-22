```typescript
     import { Auth } from '@supabase/auth-ui-react';
     import { ThemeSupa } from '@supabase/auth-ui-shared';
     import { supabase } from '@/integrations/supabase/client';

     const AuthComponent = () => {
       return (
         <div className="flex items-center justify-center min-h-screen bg-gray-100">
           <div className="w-full max-w-md p-6 bg-white rounded-lg shadow-md">
             <h2 className="text-2xl font-bold mb-4 text-center">Connexion</h2>
             <Auth
               supabaseClient={supabase}
               providers={['github', 'email']} // Inclut GitHub et Email
               appearance={{ theme: ThemeSupa }}
               localization={{
                 variables: {
                   sign_in: {
                     email_label: 'Adresse email',
                     password_label: 'Mot de passe',
                     button_label: 'Se connecter',
                   },
                   sign_up: {
                     email_label: 'Adresse email',
                     password_label: 'Mot de passe',
                     button_label: 'S’inscrire',
                   },
                 },
               }}
             />
           </div>
         </div>
       );
     };

     export default AuthComponent;
     ```
